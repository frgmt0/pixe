/**
 * Execution binding — tying the receipt chain to page code having actually run.
 *
 * READ THIS BEFORE TRUSTING ANYTHING BELOW.
 *
 * This is not a proof that a browser was used and it cannot be made into one.
 * Every challenge here is verified by the server, which means the server also
 * computes the answer, which means the answer is a deterministic function that
 * can be reimplemented outside a browser by anyone willing to write it. There
 * is no arrangement of this idea that escapes that. What this file buys is a
 * *port cost*: to answer, a bare HTTP client has to reimplement the parts of a
 * rendering engine the shipped page uses for free. It is an economic barrier
 * and it is a modest one. `docs/EXEC-BINDING.md` prices it honestly, including
 * a list of the things that defeat it.
 *
 * The design follows `attest.ts` one level down. There is no table for
 * per-issue execution counters either, so the running count lives in its own
 * HMAC-signed receipt the client carries, chained the same way and for the same
 * reason: a thousand concurrent proofs all chained from receipt zero produce a
 * thousand counts of one, and there is no operation that merges them.
 *
 * Three layers, in descending order of what they are worth:
 *
 *   1. CANVAS READBACK — load-bearing. The art layer is a 64x64 canvas written
 *      as one ImageData and CSS-scaled with `image-rendering: pixelated`, so a
 *      1:1 `getImageData` is EXACTLY the palette-mapped grid. The server picks
 *      the cells, holds the grid, and can compute the answer independently.
 *      This is the only layer that feeds the gate.
 *   2. COMPUTED STYLE — advisory. Answering needs a CSSOM that resolves the
 *      cascade and absolutises lengths. Recorded, never enforced.
 *   3. FRAME LOOP — advisory. Evidence that `requestAnimationFrame` callbacks
 *      ran at all. Deliberately *not* evidence about frame rate or timing
 *      realism: see the note on the audience below.
 *
 * WHO THIS IS AIMED AT. The intended players drive the site with Playwright or
 * Puppeteer, headless included. Headless Chromium answers all three layers
 * trivially and that is the design working, not a hole. Nothing here samples a
 * signal that distinguishes an automated browser from a human-driven one — no
 * `navigator.webdriver`, no plugin or font enumeration, no WebGL fingerprint,
 * no assumption of a compositor running at 60Hz on real hardware. Every one of
 * those fires hardest on the legitimate audience, and a check that penalises
 * headless Chromium is strictly worse than no check at all.
 *
 * DEGRADATION. Nothing in this module rejects a request. `verifyExecProof`
 * always returns a tally, a receipt and the next challenge; a proof that is
 * absent, malformed, stale or simply wrong advances the chain and increments
 * nothing. The only place a verdict is ever acted on is `gateExec`, at submit,
 * and the caller decides whether to enforce it. A false rejection here makes
 * the benchmark unusable, which is a worse outcome than a missed forgery.
 */

import { CELLS, EMPTY_RGB, HUE_RGB } from "../shared/palette";
import { b64url, hmac, sameString, sha256Hex } from "./attest";

/* ------------------------------------------------------------------ */
/* The challenge                                                       */
/* ------------------------------------------------------------------ */

/** How many cells one challenge probes. */
export const PROBE_CELLS = 12;
/** How many style declarations one challenge asks for. */
export const PROBE_STYLES = 3;

/**
 * One inline declaration to apply to a throwaway element, and the property to
 * read back off it. The set is small and every member serialises the same way
 * across engines by CSSOM rule — a hex colour becomes `rgb(r, g, b)`, a length
 * in `em` is absolutised to `px` at computed-value time, a custom property is
 * echoed. Anything whose serialisation is engine-specific was left out on
 * purpose: a mismatch here is meant to mean "no CSSOM ran", not "not Chrome".
 */
export interface ExecStyleProbe {
  /** Applied to `element.style.cssText`. */
  set: string;
  /** Passed to `getComputedStyle(el).getPropertyValue(...)`. */
  read: string;
}

export interface ExecChallenge {
  v: 1;
  /**
   * Opaque, derived from the run secret and the chain position. The answer is
   * hashed together with it, so an answer computed for one issue, one run or
   * one position in the chain is worthless anywhere else.
   */
  cid: string;
  /** Cell indices to read back off the art canvas, in this order. */
  cells: number[];
  style: ExecStyleProbe[];
  /** How many animation frames to let pass before reading. 2 or 3. */
  frames: number;
}

/** What the client sends back. Every field is optional in practice — see `check`. */
export interface ExecProof {
  v?: number;
  cid?: unknown;
  /** Hash of the probed pixel bytes, bound to `cid`. Null if the canvas was unreadable. */
  px?: unknown;
  /** Computed values, in challenge order. */
  style?: unknown;
  /** Frame timestamps, in order. Read only for "a frame loop ran". */
  raf?: unknown;
}

/* ------------------------------------------------------------------ */
/* Deriving one                                                        */
/* ------------------------------------------------------------------ */

function bytesOf(b64: string): Uint8Array {
  const pad = b64.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const hex2 = (n: number) => (n & 0xff).toString(16).padStart(2, "0");

/**
 * A style probe and the string the server expects back for it.
 *
 * Parameterised by challenge bytes so the same three templates never produce
 * the same three questions twice — a client that hard-codes three answers is
 * caught by the fourth proof rather than never.
 */
function styleProbe(pick: number, a: number, b: number): { probe: ExecStyleProbe; want: string } {
  switch (pick % 3) {
    case 0: {
      // Hex in, `rgb(r, g, b)` out. CSSOM specifies the legacy serialisation
      // for sRGB colours given as hex, and all three engines follow it.
      const c = (a ^ b) & 0xff;
      return {
        probe: { set: `color:#${hex2(a)}${hex2(b)}${hex2(c)}`, read: "color" },
        want: `rgb(${a}, ${b}, ${c})`,
      };
    }
    case 1: {
      // `em` is absolutised against the element's own font-size at
      // computed-value time, so the answer does not depend on layout, on the
      // page's fonts, or on there being a display attached.
      const n = 1 + (a % 8);
      return {
        probe: { set: `font-size:16px;width:${n}em`, read: "width" },
        want: `${16 * n}px`,
      };
    }
    default: {
      // A custom property round-trips as authored. The cheapest of the three
      // and the least informative, which is why it is only one of three.
      const name = `--pixe-x${a % 7}`;
      const token = `t${a.toString(36)}${b.toString(36)}`;
      return { probe: { set: `${name}:${token}`, read: name }, want: token };
    }
  }
}

interface Built {
  challenge: ExecChallenge;
  /** The expected computed values, never sent. */
  wantStyle: string[];
}

async function build(secret: string, runId: string, idx: number, seq: number): Promise<Built> {
  const scope = `${runId}:${idx}:${seq}`;
  const cid = (await hmac(secret, `pixe/exec/cid/1:${scope}`)).slice(0, 22);
  // Two HMACs because one base64url digest is 32 bytes and the probes want 33.
  const a = bytesOf(await hmac(secret, `pixe/exec/seed/1:${scope}`));
  const b = bytesOf(await hmac(secret, `pixe/exec/seed/2:${scope}`));
  const bytes = new Uint8Array(a.length + b.length);
  bytes.set(a, 0);
  bytes.set(b, a.length);

  const at = (i: number) => bytes[i % bytes.length] ?? 0;

  const cells: number[] = [];
  for (let i = 0; i < PROBE_CELLS; i++) {
    // CELLS is a power of two, so masking is uniform rather than merely close.
    cells.push((((at(i * 2) << 8) | at(i * 2 + 1)) & (CELLS - 1)) >>> 0);
  }

  const style: ExecStyleProbe[] = [];
  const wantStyle: string[] = [];
  for (let i = 0; i < PROBE_STYLES; i++) {
    const o = PROBE_CELLS * 2 + i * 3;
    const p = styleProbe(at(o), at(o + 1), at(o + 2));
    style.push(p.probe);
    wantStyle.push(p.want);
  }

  const frames = 2 + (at(PROBE_CELLS * 2 + PROBE_STYLES * 3) % 2);
  return { challenge: { v: 1, cid, cells, style, frames }, wantStyle };
}

/**
 * The challenge for one position in a run's execution chain.
 *
 * Bound to the run secret, the issue index and the receipt's current `seq`, so
 * it cannot be precomputed (the secret never leaves the database), replayed
 * across issues, or lifted from another run.
 */
export async function execChallenge(
  secret: string, runId: string, idx: number, seq: number,
): Promise<ExecChallenge> {
  return (await build(secret, runId, idx, seq)).challenge;
}

/* ------------------------------------------------------------------ */
/* The canvas answer                                                   */
/* ------------------------------------------------------------------ */

/**
 * The bytes a 1:1 `getImageData` returns for the given cells, as hex.
 *
 * This is the whole reason the canvas layer is worth anything: `PixelCanvas`
 * writes one ImageData at native grid resolution and scales it with CSS, so the
 * backing store is the palette-mapped grid exactly, with no resampling and no
 * engine-specific filtering in the way. Alpha is always 255 because the art
 * layer writes it unconditionally.
 */
export function paletteBytes(grid: Int8Array, cells: number[]): string {
  let s = "";
  for (const c of cells) {
    const v = grid[c] ?? -1;
    const rgb = v < 0 ? EMPTY_RGB : (HUE_RGB[v] ?? EMPTY_RGB);
    s += hex2(rgb[0]) + hex2(rgb[1]) + hex2(rgb[2]) + "ff";
  }
  return s;
}

/**
 * The pixel answer, bound to the challenge id.
 *
 * `src/game/execProof.ts` computes this same string in the page. The two are
 * deliberately separate copies rather than one shared import: the client bundle
 * must not reach into `server/`, and this project has already been burned once
 * by shipping server-side derivation to the browser. Change one, change both —
 * `exec-bind.test.ts` pins the format.
 */
export async function pixelAnswer(cid: string, bytesHex: string): Promise<string> {
  return (await sha256Hex(`pixe/exec/px/1:${cid}:${bytesHex}`)).slice(0, 32);
}

/* ------------------------------------------------------------------ */
/* The receipt                                                         */
/* ------------------------------------------------------------------ */

/**
 * The per-issue execution tally. `pixel` is the only field the gate reads;
 * everything else is here so an operator can see whether the advisory layers
 * are agreeing, and notice early if one of them has started firing on honest
 * clients.
 */
export interface ExecTally {
  /** Chain position. Also the index of the challenge to answer next. */
  seq: number;
  /** Proofs presented, well-formed or not. */
  proofs: number;
  /** Readbacks that equalled the palette-mapped grid the server holds. */
  pixel: number;
  /** Proofs that carried usable frame-loop evidence. */
  frames: number;
  /** Proofs whose computed-style answers all matched. */
  style: number;
  /** Server clock at the last matching readback. Never a client timestamp. */
  lastAt: number;
}

export const EMPTY_EXEC_TALLY: ExecTally = {
  seq: 0, proofs: 0, pixel: 0, frames: 0, style: 0, lastAt: 0,
};

const RECEIPT_TAG = "pixe/exec/receipt/1";

function encodeExecTally(t: ExecTally): string {
  return b64url(
    new TextEncoder().encode(
      `${t.seq}|${t.proofs}|${t.pixel}|${t.frames}|${t.style}|${t.lastAt}`,
    ),
  );
}

function decodeExecTally(payload: string): ExecTally | null {
  try {
    const pad = payload.replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
    const parts = raw.split("|").map(Number);
    if (parts.length !== 6 || parts.some((n) => !Number.isSafeInteger(n) || n < 0)) return null;
    const [seq, proofs, pixel, frames, style, lastAt] = parts as [
      number, number, number, number, number, number,
    ];
    return { seq, proofs, pixel, frames, style, lastAt };
  } catch {
    return null;
  }
}

export async function signExecReceipt(
  secret: string, runId: string, idx: number, t: ExecTally,
): Promise<string> {
  const payload = encodeExecTally(t);
  return `${payload}.${await hmac(secret, `${RECEIPT_TAG}:${runId}:${idx}:${payload}`)}`;
}

/** A receipt for zero proofs, handed out with a fresh issue alongside challenge 0. */
export function openExecReceipt(secret: string, runId: string, idx: number): Promise<string> {
  return signExecReceipt(secret, runId, idx, EMPTY_EXEC_TALLY);
}

/**
 * `null` for anything not signed by this run for this issue. An older receipt
 * verifies fine and simply carries a smaller tally — rewinding your own
 * progress is not an attack, it is a page reload.
 */
export async function readExecReceipt(
  secret: string, runId: string, idx: number, receipt: unknown,
): Promise<ExecTally | null> {
  if (typeof receipt !== "string" || receipt.length > 512) return null;
  const dot = receipt.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = receipt.slice(0, dot);
  const want = await hmac(secret, `${RECEIPT_TAG}:${runId}:${idx}:${payload}`);
  if (!sameString(want, receipt.slice(dot + 1))) return null;
  return decodeExecTally(payload);
}

/* ------------------------------------------------------------------ */
/* Checking a proof                                                    */
/* ------------------------------------------------------------------ */

export type LayerVerdict = "match" | "mismatch" | "absent";

export interface ExecVerdict {
  /** The load-bearing layer. Only `match` advances `tally.pixel`. */
  pixel: LayerVerdict;
  /** Advisory. Recorded, never enforced. */
  style: LayerVerdict;
  /** Advisory. `match` means frame callbacks ran; nothing is inferred about rate. */
  frames: LayerVerdict;
  /**
   * Short machine-ish tags for the operator: `no-proof`, `stale-challenge`,
   * `no-grid`, `canvas-mismatch`, `receipt-reset`, `style-mismatch`.
   * Diagnostic only. Nothing in this module branches on them.
   */
  notes: string[];
}

/** Whitespace and case are not part of any answer here. */
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "");

function checkFrames(raw: unknown): LayerVerdict {
  if (!Array.isArray(raw) || raw.length < 2) return "absent";
  let last = -Infinity;
  for (const v of raw) {
    // Finite, non-negative, non-decreasing. That is the entire test: evidence
    // that a frame loop ran, not evidence about how fast it ran. Headless
    // engines schedule frames on a virtual clock and containers stall for
    // seconds at a time, and both are legitimate players here.
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v < last) return "mismatch";
    last = v;
  }
  return "match";
}

function checkStyle(raw: unknown, want: string[]): LayerVerdict {
  if (!Array.isArray(raw) || raw.length !== want.length) return "absent";
  for (let i = 0; i < want.length; i++) {
    const got = raw[i];
    if (typeof got !== "string" || got === "") return "absent";
    if (norm(got) !== norm(want[i]!)) return "mismatch";
  }
  return "match";
}

/* ------------------------------------------------------------------ */
/* The verified proof                                                  */
/* ------------------------------------------------------------------ */

export interface ExecCheck {
  secret: string;
  runId: string;
  idx: number;
  /** The exec receipt the client presented. Absent or unreadable starts a fresh chain. */
  receipt: unknown;
  /** The proof object the client presented, if any. */
  proof: unknown;
  /**
   * The grid this envelope carried, already decoded by the caller. `null` when
   * the envelope had no canvas attached — which is legitimate (`/api/attest`
   * omits `art` during a pause) and makes the readback unverifiable rather than
   * wrong.
   */
  grid: Int8Array | null;
  /** Server clock. */
  now: number;
}

export interface ExecOutcome {
  tally: ExecTally;
  /** Hand back to the client; it presents this with the next proof. */
  receipt: string;
  /** Hand back to the client; it answers this one next. */
  challenge: ExecChallenge;
  verdict: ExecVerdict;
}

/**
 * Verify one execution proof and advance the chain.
 *
 * This never fails. A missing proof, a proof for the wrong challenge, a
 * mismatched readback and an envelope with no canvas attached all produce the
 * same shape of answer: the chain advances, the counters that were not earned
 * do not move, and the verdict says why. Enforcement happens once, at submit,
 * in `gateExec` — and even there the caller decides whether to act.
 */
export async function verifyExecProof(input: ExecCheck): Promise<ExecOutcome> {
  const { secret, runId, idx, now } = input;
  const notes: string[] = [];

  let prev = await readExecReceipt(secret, runId, idx, input.receipt);
  if (!prev) {
    // Not an error. A client that lost its receipt starts over, and starting
    // over only ever lowers the tally, which never helps anyone.
    if (input.receipt !== undefined && input.receipt !== null && input.receipt !== "") {
      notes.push("receipt-reset");
    }
    prev = EMPTY_EXEC_TALLY;
  }

  const built = await build(secret, runId, idx, prev.seq);
  const verdict: ExecVerdict = { pixel: "absent", style: "absent", frames: "absent", notes };

  const proof = (input.proof ?? null) as ExecProof | null;
  const presented = !!proof && typeof proof === "object";
  if (!presented) notes.push("no-proof");

  // The binding. An answer is only ever an answer to the challenge the chain is
  // currently on, for this run and this issue.
  const onChallenge =
    presented && typeof proof.cid === "string" && sameString(proof.cid, built.challenge.cid);
  if (presented && !onChallenge) notes.push("stale-challenge");

  if (onChallenge) {
    verdict.frames = checkFrames(proof.raf);
    verdict.style = checkStyle(proof.style, built.wantStyle);
    if (verdict.style === "mismatch") notes.push("style-mismatch");

    if (typeof proof.px !== "string" || proof.px === "") {
      verdict.pixel = "absent";
    } else if (!input.grid) {
      // Nothing to check it against. Inconclusive, not wrong.
      verdict.pixel = "absent";
      notes.push("no-grid");
    } else {
      const want = await pixelAnswer(
        built.challenge.cid,
        paletteBytes(input.grid, built.challenge.cells),
      );
      if (sameString(want, proof.px)) {
        verdict.pixel = "match";
      } else {
        // Expected occasionally in honest play: the canvas is painted from a
        // React effect and the grid is snapshotted separately, so a stroke
        // landing between the two produces a real, innocent mismatch. One
        // uncounted proof out of the dozens a session produces costs nothing.
        verdict.pixel = "mismatch";
        notes.push("canvas-mismatch");
      }
    }
  }

  const tally: ExecTally = {
    seq: prev.seq + 1,
    proofs: prev.proofs + (presented ? 1 : 0),
    pixel: prev.pixel + (verdict.pixel === "match" ? 1 : 0),
    frames: prev.frames + (verdict.frames === "match" ? 1 : 0),
    style: prev.style + (verdict.style === "match" ? 1 : 0),
    lastAt: verdict.pixel === "match" ? now : prev.lastAt,
  };

  return {
    tally,
    receipt: await signExecReceipt(secret, runId, idx, tally),
    challenge: await execChallenge(secret, runId, idx, tally.seq),
    verdict,
  };
}

/* ------------------------------------------------------------------ */
/* The gate                                                            */
/* ------------------------------------------------------------------ */

/**
 * Tuned the same way `attest.ts`'s gate is: below any plausible honest session
 * rather than above an implausible forged one. A page painting a 4096-cell
 * board settles dozens of times, so three matching readbacks is a floor a real
 * session clears in the first few seconds of play and a floor no amount of
 * innocent canvas/grid skew can push a session under.
 *
 * `freshMs` matches the attestation gate's, so the two cannot disagree about
 * whether a session has gone stale.
 */
export const EXEC_GATE = {
  pixel: 3,
  freshMs: 120_000,
};

/**
 * The complaint, or `null` when the tally clears.
 *
 * **Enforcement is the caller's decision, and it should start as observe-only.**
 * A client that has not been taught to send proofs yet — an older page, a
 * harness driving the JSON API, anything mid-rollout — produces an empty tally
 * and would be refused by a gate that is live from day one. Log the complaint
 * first, watch how often it fires on runs that are plainly honest, and only
 * then turn it into a 403.
 */
export function gateExec(t: ExecTally, now: number): string | null {
  if (t.pixel < EXEC_GATE.pixel) {
    return "This grid was never read back off a canvas the page had rendered.";
  }
  if (t.lastAt > 0 && now - t.lastAt > EXEC_GATE.freshMs) {
    return "The page stopped proving it was rendering. Keep playing.";
  }
  return null;
}
