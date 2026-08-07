/**
 * The in-page half of execution binding.
 *
 * The server hands out a challenge with every attestation response; this
 * answers it by doing three things a rendering engine does for free and a bare
 * HTTP client has to reimplement:
 *
 *   1. read pixels back off the art canvas the page has already rendered,
 *   2. resolve a handful of CSS declarations through `getComputedStyle`,
 *   3. wait for a couple of animation frames.
 *
 * `server/exec-bind.ts` says at length what this is worth, and
 * `docs/EXEC-BINDING.md` prices it. The short version: it is an economic
 * barrier, not a proof, and a determined reader recovers this file from the
 * bundle in an afternoon. It is aimed at making the honest path — drive the
 * page, call this once per batch — cheaper than the alternative, not at making
 * the alternative impossible.
 *
 * NOTHING HERE THROWS. Every step is wrapped, and a step that cannot run
 * produces a `null` in the proof rather than an exception in the caller's
 * attestation loop. The server treats an absent answer as inconclusive.
 *
 * This module does not import from `server/`. The pixel answer's hash format is
 * duplicated there deliberately: the client bundle reaching into the server's
 * verifier is exactly the mistake that cost this project 1105 solves, and one
 * shared three-line function is not worth reopening it. `pixelAnswer` in
 * `server/exec-bind.ts` is the other copy; change one, change both.
 */

import { CELLS, GRID } from "@shared/palette";

export interface ExecStyleProbe {
  set: string;
  read: string;
}

export interface ExecChallenge {
  v: 1;
  cid: string;
  cells: number[];
  style: ExecStyleProbe[];
  frames: number;
}

export interface ExecProof {
  v: 1;
  cid: string;
  /** Hash of the probed pixel bytes, bound to `cid`. `null` if the canvas was unreadable. */
  px: string | null;
  /** Computed values in challenge order; `null` for a probe that could not be read. */
  style: (string | null)[];
  /** Frame timestamps. The server reads these only as "a frame loop ran". */
  raf: number[];
}

/** Beyond this a frame is not coming — a hidden tab, mostly. Proceed without it. */
const FRAME_TIMEOUT_MS = 250;
/** Sanity bound on a challenge, so a malformed one cannot spin the page. */
const MAX_PROBES = 64;

/* ------------------------------------------------------------------ */
/* Finding the canvas                                                  */
/* ------------------------------------------------------------------ */

/**
 * The art layer, located structurally.
 *
 * `PixelCanvas` stacks three canvases inside a `role="application"` wrapper;
 * art is the first, and it is the only one whose backing store is the grid at
 * native resolution. This is a real coupling to that component's markup, and
 * the honest mitigation is that breaking it produces an inconclusive proof
 * rather than a rejected submit. A `data-pixe-layer="art"` attribute on that
 * canvas would make this exact rather than positional; adding one is a change
 * to a file this module does not own.
 */
function artCanvas(root: ParentNode = document): HTMLCanvasElement | null {
  const host = root.querySelector('[role="application"]') ?? root;
  for (const c of Array.from(host.querySelectorAll("canvas"))) {
    if (c.width === GRID && c.height === GRID) return c;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The three layers                                                    */
/* ------------------------------------------------------------------ */

const hex2 = (n: number) => (n & 0xff).toString(16).padStart(2, "0");

function nextFrame(): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== "function") return resolve(null);
    let settled = false;
    const done = (v: number | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    // A backgrounded tab stops firing frames entirely. Waiting forever there
    // would stall the attestation batch behind it, so the timeout is the
    // degradation path rather than a timing measurement.
    const timer = setTimeout(() => done(null), FRAME_TIMEOUT_MS);
    requestAnimationFrame((ts) => {
      clearTimeout(timer);
      done(ts);
    });
  });
}

/**
 * The load-bearing layer. One full-grid `getImageData`, then the challenge's
 * cells picked out of it — cheaper than N one-pixel reads, and it guarantees
 * every probe sees the same frame.
 *
 * The art canvas is exactly `GRID` wide, so cell index `c` starts at byte
 * `c * 4`. That identity is the whole point: the readback IS the palette-mapped
 * grid, with no resampling in the way, which is why the server can compute the
 * same bytes from the grid it already holds.
 */
function readCells(canvas: HTMLCanvasElement, cells: number[]): string | null {
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    const px = ctx.getImageData(0, 0, GRID, GRID).data;
    let out = "";
    for (const c of cells) {
      if (!Number.isInteger(c) || c < 0 || c >= CELLS) return null;
      const o = c * 4;
      out +=
        hex2(px[o] ?? 0) + hex2(px[o + 1] ?? 0) + hex2(px[o + 2] ?? 0) + hex2(px[o + 3] ?? 0);
    }
    return out;
  } catch {
    // A tainted canvas would throw here. The page never draws cross-origin
    // images onto it, so this is defensive rather than expected.
    return null;
  }
}

/**
 * Apply each declaration to a throwaway element and read the computed value
 * back. Attached to the document, not detached: an element outside the tree has
 * no computed style at all in some engines, and the point is to make the
 * cascade run.
 */
function readStyles(probes: ExecStyleProbe[]): (string | null)[] {
  const out: (string | null)[] = [];
  let el: HTMLElement | null = null;
  try {
    el = document.createElement("div");
    // Off-screen and inert. `visibility:hidden` rather than `display:none`
    // because the former still lays out, and laying out is the work being
    // demonstrated.
    el.setAttribute("aria-hidden", "true");
    el.style.cssText = "position:absolute;left:-9999px;top:0;height:1px;visibility:hidden";
    document.body.appendChild(el);
    for (const p of probes) {
      try {
        el.style.cssText =
          "position:absolute;left:-9999px;top:0;height:1px;visibility:hidden;" + p.set;
        out.push(getComputedStyle(el).getPropertyValue(p.read).trim() || null);
      } catch {
        out.push(null);
      }
    }
  } catch {
    while (out.length < probes.length) out.push(null);
  } finally {
    el?.remove();
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The answer                                                          */
/* ------------------------------------------------------------------ */

/**
 * SHA-256 over the challenge id and the probed bytes, truncated.
 *
 * Binding the bytes to `cid` is what stops an answer being lifted: `cid` is
 * derived from the run secret, the issue index and the position in the receipt
 * chain, so the same twelve pixels answered one position earlier hash to
 * something else.
 *
 * Mirrors `pixelAnswer` in `server/exec-bind.ts`.
 */
async function pixelAnswer(cid: string, bytesHex: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  // Absent on plain HTTP outside localhost. Degrades to an inconclusive proof
  // rather than a broken page.
  if (!subtle) return null;
  try {
    const d = await subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`pixe/exec/px/1:${cid}:${bytesHex}`),
    );
    return Array.from(new Uint8Array(d), (b) => hex2(b)).join("").slice(0, 32);
  } catch {
    return null;
  }
}

function usable(ch: unknown): ch is ExecChallenge {
  if (!ch || typeof ch !== "object") return false;
  const c = ch as ExecChallenge;
  return (
    typeof c.cid === "string" &&
    c.cid.length > 0 &&
    Array.isArray(c.cells) &&
    c.cells.length > 0 &&
    c.cells.length <= MAX_PROBES &&
    Array.isArray(c.style) &&
    c.style.length <= MAX_PROBES
  );
}

/**
 * Answer one challenge. `null` when there is nothing sensible to answer — no
 * challenge, or a malformed one — which the caller should treat as "send the
 * batch without a proof" rather than as an error.
 *
 * Call this immediately before snapshotting the grid for the same envelope. The
 * two can still skew if a stroke lands in between, and that is fine: the server
 * counts a skewed proof as inconclusive and an honest session produces dozens.
 */
export async function proveExec(challenge: unknown, root?: ParentNode): Promise<ExecProof | null> {
  if (!usable(challenge)) return null;
  const ch = challenge;

  const raf: number[] = [];
  const want = Math.min(4, Math.max(1, Math.round(ch.frames) || 2));
  for (let i = 0; i < want; i++) {
    const ts = await nextFrame();
    if (ts === null) break;
    raf.push(ts);
  }

  // After the frames, so the readback sees whatever the last frame painted.
  const canvas = artCanvas(root);
  const bytes = canvas ? readCells(canvas, ch.cells) : null;

  return {
    v: 1,
    cid: ch.cid,
    px: bytes === null ? null : await pixelAnswer(ch.cid, bytes),
    style: readStyles(ch.style),
    raf,
  };
}
