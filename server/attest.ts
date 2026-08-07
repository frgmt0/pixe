/**
 * Browser-event attestation.
 *
 * Be clear about what this is and is not. The chained puzzle sequence is a
 * cryptographic guarantee: you cannot compute puzzle n+1 without the accepted
 * solution to puzzle n, full stop. Nothing here is that. This layer raises the
 * cost of driving the JSON API without ever rendering the page, and every part
 * of it is reproducible by a script that is willing to do the work. It is
 * deterrence, priced in effort. The threat model says so in the same words.
 *
 * Two structural properties, and neither is a claim about *who* painted.
 *
 * SERIALISATION comes from the same trick as the puzzle chain, one level down.
 * There is no table for per-issue counters, so the running tally lives in a
 * signed receipt the client carries: every batch presents the previous receipt
 * and gets back a new one with the tally advanced. Forging a higher tally needs
 * the run secret; replaying an older receipt only rewinds you. Firing a
 * thousand concurrent batches all chained from receipt zero yields a thousand
 * tallies of one, because there is no way to merge them.
 *
 * REPLAY BINDING is the part that makes the events mean something. Every event
 * carries the exact cells it wrote, the receipt carries the grid those writes
 * have built up so far, and each batch is checked by *replaying* it: the writes
 * applied to the receipt's grid must produce, cell for cell, the canvas the
 * client is asking for feedback on. At submit the presented grid must equal
 * that same replayed grid. So an envelope is no longer content-free ceremony a
 * script can emit alongside an answer it computed elsewhere — the envelope has
 * to *contain* the answer, as a legal sequence of painting operations, pushed
 * through a chain that will not merge.
 *
 * What replay binding does NOT buy, stated plainly because the previous version
 * of this file overclaimed and lost 1105 solves to it: it is no evidence at all
 * about what moved the pointer. A script that decomposes its solution into
 * strokes and posts them satisfies every check here. What it costs that script
 * is that the decomposition, the ordering and the serial round trips are now
 * mandatory — which is very close to the cost of just driving the page, and
 * driving the page produces all of it for free.
 *
 * NOTHING HERE TRIES TO TELL A HUMAN FROM AN AUTOMATED BROWSER, and nothing
 * here ever should. The intended players drive the site with Playwright or
 * Puppeteer, headless included. `page.mouse.move()` produces perfectly uniform
 * inter-event timing, integer coordinates and linear interpolation — every
 * "does this look like a real hand?" heuristic fires hardest on exactly the
 * clients this benchmark is for. A check that penalises them is strictly worse
 * than no check. So the file checks arithmetic, not plausibility: either the
 * strokes on record paint the grid or they do not.
 */

import { decodeGrid, encodeGrid } from "../shared/codec";
import { CELLS, EMPTY } from "../shared/palette";
import { emptyGrid, type Grid } from "../shared/rules";

/* ------------------------------------------------------------------ */
/* Signing primitives — shared with the run token in runs.ts           */
/* ------------------------------------------------------------------ */

const keyCache = new Map<string, Promise<CryptoKey>>();

/**
 * HMAC keys are derived per run secret and cached per isolate. Importing a key
 * costs more than signing with it, and the feedback endpoint signs on every
 * round trip.
 */
function macKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    // Bounded: a busy Worker isolate would otherwise pin every run it has seen.
    if (keyCache.size > 512) keyCache.clear();
    keyCache.set(secret, k);
  }
  return k;
}

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = new Uint8Array(bytes as ArrayBuffer);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Base64url of HMAC-SHA256. Every call site prefixes a distinct domain tag. */
export async function hmac(secret: string, msg: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await macKey(secret), new TextEncoder().encode(msg));
  return b64url(sig);
}

/** SHA-256, hex. Used for the chain's solution digest. */
export async function sha256Hex(msg: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time, so no comparison here can be turned into an oracle. */
export function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* The envelope                                                        */
/* ------------------------------------------------------------------ */

/**
 * Bumped from 1 to 2 when events grew their write ledger. An envelope without
 * this field is a client from before the ledger existed, and it is refused with
 * a sentence that says so rather than being quietly accepted with an empty
 * ledger — a version skew that degrades into "attestation proves nothing" is
 * the failure mode worth being loud about.
 */
export const ENVELOPE_VERSION = 2;

export const EVENT_KINDS = ["stroke", "paint", "pick", "undo", "view", "intent"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface AttestedEvent {
  t: EventKind;
  /** Client clock, ms. Checked for monotonicity and freshness, never trusted. */
  at: number;
  /** Cells touched, for `stroke` and `paint`. Descriptive; `w` is load-bearing. */
  n?: number;
  /** Duration in ms, for `stroke`. */
  d?: number;
  /**
   * The write ledger: exactly which cells this event set, and to what. See
   * `parseWrites` for the grammar. Optional because plenty of events (a tool
   * pick, a tab regaining focus) change no pixels — but an envelope that claims
   * to have moved the canvas without one is refused.
   */
  w?: string;
}

/**
 * The running total for one issue, carried in a signed receipt rather than a
 * row. `seq` is the batch counter; the rest is what the submit gate reads.
 *
 * `filled` and `bound` are derived when a receipt is read and are deliberately
 * *not* part of the signed payload: `filled` is a function of the grid the
 * receipt already carries, and `bound` is a fact about the request being served
 * rather than about the tally. Nothing the client sends can set either.
 */
export interface AttestTally {
  seq: number;
  events: number;
  strokes: number;
  intents: number;
  firstAt: number;
  lastAt: number;
  /** Cells written across every attested event, repaints included. */
  writes: number;
  /** Non-empty cells in the replayed grid. Derived. */
  filled: number;
  /** Submit only: the grid presented is the one the ledger paints. Derived. */
  bound: boolean;
}

export const EMPTY_TALLY: AttestTally = {
  seq: 0, events: 0, strokes: 0, intents: 0, firstAt: 0, lastAt: 0,
  writes: 0, filled: 0, bound: false,
};

const MAX_BATCH = 64;
/** A batch older than this was prepared, not observed. */
const MAX_EVENT_AGE_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const MAX_STROKE_MS = 60 * 1000;
/** Nonces expire on this cadence; the previous window is accepted too. */
const NONCE_EPOCH_MS = 5 * 60 * 1000;

/**
 * A single event's ledger cannot describe more runs than there are cells, and a
 * batch is bounded well below what the router's 64KB body limit allows anyway.
 * These exist so a malformed string costs a parse, not a loop.
 */
const MAX_WRITE_CHARS = 48 * 1024;
const MAX_RUNS_PER_BATCH = 8 * CELLS;
/** A full grid RLEs to at most two chars per cell; the tally prefix is tiny. */
const MAX_RECEIPT_CHARS = 16 * 1024;

/* --- submit gate ------------------------------------------------- */

/**
 * What must have happened in the browser before a grid is bankable. Tuned to
 * sit below any plausible honest session rather than above an implausible
 * forged one — a gate that rejects real play is a worse bug than one a script
 * can clear, because the first breaks the benchmark and the second only fails
 * to improve it.
 *
 * `MIN_SPAN_MS` is deliberately tiny. Wall clock is the headline metric, so a
 * meaningful floor here would be a floor on the number being measured, and the
 * benchmark would be reporting the gate rather than the agent.
 *
 * These counts are the weak half of the gate and always were. The half that
 * costs anything is `bound`, below, which is not a threshold at all.
 */
export const GATE = {
  strokes: 8,
  events: 24,
  spanMs: 3_000,
  /** The last attested event must be this recent at submit time. */
  freshMs: 120_000,
  intents: 1,
};

/* ------------------------------------------------------------------ */
/* The write ledger                                                    */
/* ------------------------------------------------------------------ */

/**
 * `<hueChar><gap><'-'len>` repeated, where
 *
 *   hueChar   'a'..'h' = hue 0..7, 'i' = erased to empty
 *   gap       uppercase base36, cells skipped since the end of the previous
 *             run; absent means 0
 *   len       uppercase base36, cells in this run; absent means 1
 *
 * So `c-40` is forty cells of Banana starting at 0, and `a2b1` is one Tomato
 * cell two on from the last write and one Tangerine cell after that. The same
 * lowercase/uppercase split the grid codec uses, for the same reason: the
 * stream is unambiguous with no separators, and single-cell runs — which is
 * most of what a brush produces — cost three characters.
 *
 * Because gaps are non-negative and each run advances the cursor past its own
 * end, a ledger is sorted and non-overlapping by construction. That is not a
 * plausibility heuristic, it is the shape of a diff: one entry per cell.
 */
export interface WriteRun {
  start: number;
  len: number;
  /** Hue 0..7, or `EMPTY` for an erase. */
  hue: number;
}

const LEDGER_CHARS = "abcdefghi";
const B36 = /^[0-9A-Z]$/;

export function parseWrites(s: string): WriteRun[] | null {
  if (typeof s !== "string" || s.length > MAX_WRITE_CHARS) return null;
  const out: WriteRun[] = [];
  let at = 0;
  let i = 0;
  while (i < s.length) {
    const v = LEDGER_CHARS.indexOf(s[i]!);
    if (v < 0) return null;
    i++;

    const gapAt = i;
    while (i < s.length && B36.test(s[i]!)) i++;
    const gap = i === gapAt ? 0 : parseInt(s.slice(gapAt, i), 36);

    let len = 1;
    if (s[i] === "-") {
      i++;
      const lenAt = i;
      while (i < s.length && B36.test(s[i]!)) i++;
      if (i === lenAt) return null;
      len = parseInt(s.slice(lenAt, i), 36);
    }

    if (!Number.isSafeInteger(gap) || gap < 0) return null;
    if (!Number.isSafeInteger(len) || len < 1) return null;
    const start = at + gap;
    if (start + len > CELLS) return null;
    out.push({ start, len, hue: v === 8 ? EMPTY : v });
    at = start + len;
    if (out.length > MAX_RUNS_PER_BATCH) return null;
  }
  return out;
}

/** Encoder, kept beside the parser so the round trip is testable in one place. */
export function encodeWrites(runs: readonly WriteRun[]): string {
  let out = "";
  let end = 0;
  for (const r of runs) {
    const gap = r.start - end;
    out += LEDGER_CHARS[r.hue < 0 ? 8 : r.hue];
    if (gap > 0) out += gap.toString(36).toUpperCase();
    if (r.len > 1) out += `-${r.len.toString(36).toUpperCase()}`;
    end = r.start + r.len;
  }
  return out;
}

function applyWrites(grid: Grid, runs: readonly WriteRun[]): number {
  let cells = 0;
  for (const r of runs) {
    grid.fill(r.hue, r.start, r.start + r.len);
    cells += r.len;
  }
  return cells;
}

function sameGrid(a: Grid, b: Grid): boolean {
  for (let i = 0; i < CELLS; i++) if (a[i] !== b[i]) return false;
  return true;
}

function countFilled(g: Grid): number {
  let n = 0;
  for (let i = 0; i < CELLS; i++) if (g[i]! >= 0) n++;
  return n;
}

/* ------------------------------------------------------------------ */
/* Nonces                                                              */
/* ------------------------------------------------------------------ */

/**
 * Bound to run, issue and batch counter, and it ages out. What it actually
 * buys, stated plainly: a batch cannot be built before the issue exists, cannot
 * be moved to another issue, and cannot be stockpiled in advance. It buys very
 * little on top of the receipt chain, which already binds run and issue and is
 * already serial — it is kept because it costs one HMAC and closes the
 * pre-computation case cleanly.
 */
export async function nonceFor(
  secret: string, runId: string, idx: number, seq: number, now: number,
): Promise<string> {
  const epoch = Math.floor(now / NONCE_EPOCH_MS);
  return (await hmac(secret, `pixe/nonce/1:${runId}:${idx}:${seq}:${epoch}`)).slice(0, 22);
}

async function nonceOk(
  secret: string, runId: string, idx: number, seq: number, nonce: string, now: number,
): Promise<boolean> {
  if (typeof nonce !== "string" || nonce.length !== 22) return false;
  // The current window and the one before it, so a batch in flight across an
  // epoch boundary is not punished for arriving a millisecond late.
  for (const t of [now, now - NONCE_EPOCH_MS]) {
    if (sameString(await nonceFor(secret, runId, idx, seq, t), nonce)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Receipts                                                            */
/* ------------------------------------------------------------------ */

/**
 * A receipt is `<tally>~<grid>.<mac>`. The grid is the ordinary run-length
 * encoding, carried verbatim because it is already in a disjoint alphabet from
 * base64url and from `~`.
 *
 * Carrying the whole grid rather than a digest of it is deliberate and is the
 * only reason cross-batch replay is possible without a per-issue table: the
 * server has to be able to *apply* the next batch's writes to something. It
 * costs a few hundred bytes on a typical board and at most ~8KB on a
 * pathological one, in each direction, per round trip. That is the price of
 * keeping the two runtimes identical — a Worker isolate has nowhere else to put
 * it, and D1 would make it a write on every attest.
 */
const RECEIPT_TAG = `pixe/receipt/${ENVELOPE_VERSION}`;

interface Sealed {
  tally: AttestTally;
  grid: Grid;
}

function encodeTally(t: AttestTally): string {
  return b64url(
    new TextEncoder().encode(
      `${t.seq}|${t.events}|${t.strokes}|${t.intents}|${t.firstAt}|${t.lastAt}|${t.writes}`,
    ),
  );
}

function decodeTally(payload: string): AttestTally | null {
  try {
    const pad = payload.replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
    const parts = raw.split("|").map(Number);
    if (parts.length !== 7 || parts.some((n) => !Number.isSafeInteger(n) || n < 0)) return null;
    const [seq, events, strokes, intents, firstAt, lastAt, writes] = parts as [
      number, number, number, number, number, number, number,
    ];
    return { seq, events, strokes, intents, firstAt, lastAt, writes, filled: 0, bound: false };
  } catch {
    return null;
  }
}

export async function signReceipt(
  secret: string, runId: string, idx: number, t: AttestTally, grid: Grid,
): Promise<string> {
  const payload = `${encodeTally(t)}~${encodeGrid(grid)}`;
  return `${payload}.${await hmac(secret, `${RECEIPT_TAG}:${runId}:${idx}:${payload}`)}`;
}

/** A receipt for zero events over an empty canvas, handed out with a fresh issue. */
export function openReceipt(secret: string, runId: string, idx: number): Promise<string> {
  return signReceipt(secret, runId, idx, EMPTY_TALLY, emptyGrid());
}

/**
 * `null` for anything not signed by this run for this issue. A stale receipt
 * from an earlier batch verifies fine — it just carries a smaller tally and an
 * earlier canvas, and rewinding your own progress is not an attack. It is also
 * not a way to smuggle a grid past the ledger: the batch that follows still has
 * to paint the canvas it asks about, starting from the rewound state.
 */
async function unseal(
  secret: string, runId: string, idx: number, receipt: unknown,
): Promise<Sealed | null> {
  if (typeof receipt !== "string" || receipt.length > MAX_RECEIPT_CHARS) return null;
  const dot = receipt.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = receipt.slice(0, dot);
  const mac = receipt.slice(dot + 1);
  const want = await hmac(secret, `${RECEIPT_TAG}:${runId}:${idx}:${payload}`);
  if (!sameString(want, mac)) return null;

  const split = payload.indexOf("~");
  if (split < 0) return null;
  const tally = decodeTally(payload.slice(0, split));
  const grid = decodeGrid(payload.slice(split + 1));
  if (!tally || !grid) return null;
  tally.filled = countFilled(grid);
  return { tally, grid };
}

/**
 * Verify a receipt and bind it to the grid it is about to be spent on. This is
 * the clean submit-side entry point: hand it the receipt and the decoded canvas
 * and it comes back with `bound` set iff the ledger paints that canvas.
 *
 * `bound: false` is not the same as `null`. A signature failure is "this is not
 * ours"; an unbound receipt is genuinely ours and merely spent on the wrong
 * grid, and `gateSubmit` turns that into a sentence that says which.
 */
export async function bindReceipt(
  secret: string, runId: string, idx: number, receipt: unknown, grid: Grid | null,
): Promise<AttestTally | null> {
  const sealed = await unseal(secret, runId, idx, receipt);
  if (!sealed) return null;
  sealed.tally.bound = !!grid && sameGrid(grid, sealed.grid);
  return sealed.tally;
}


/* ------------------------------------------------------------------ */
/* Event checking                                                      */
/* ------------------------------------------------------------------ */

interface BatchCount {
  events: number;
  strokes: number;
  intents: number;
  firstAt: number;
  lastAt: number;
  /** Every event's ledger, in the order the events arrived. */
  writes: WriteRun[][];
}

/**
 * Shape and ordering only. Nothing here looks at the *distribution* of
 * anything — no cadence, no jitter, no velocity, no coordinate realism. Those
 * would all fire hardest on a headless Playwright run, which is the audience.
 */
function checkBatch(raw: unknown, prev: AttestTally, now: number): BatchCount | string {
  if (!Array.isArray(raw) || raw.length === 0) return "No events in that envelope.";
  if (raw.length > MAX_BATCH) return "Too many events in one envelope.";

  const kinds = new Set<string>(EVENT_KINDS);
  const out: BatchCount = { events: 0, strokes: 0, intents: 0, firstAt: 0, lastAt: 0, writes: [] };
  let last = prev.lastAt;
  let runs = 0;

  for (const e of raw as AttestedEvent[]) {
    if (!e || typeof e !== "object") return "Malformed event.";
    if (!kinds.has(e.t)) return "Unknown event kind.";
    if (!Number.isSafeInteger(e.at)) return "Event timestamp is not a timestamp.";
    if (e.at > now + CLOCK_SKEW_MS) return "Event timestamp is in the future.";
    if (e.at < now - MAX_EVENT_AGE_MS) return "Event batch is too old to attest.";
    // Within an issue the stream must only move forward, across batches too.
    if (e.at < last) return "Events are out of order.";
    last = e.at;

    if (e.t === "stroke") {
      if (!Number.isSafeInteger(e.n) || (e.n as number) < 1 || (e.n as number) > CELLS) {
        return "Stroke covers an impossible number of cells.";
      }
      if (!Number.isSafeInteger(e.d) || (e.d as number) < 0 || (e.d as number) > MAX_STROKE_MS) {
        return "Stroke duration is out of range.";
      }
      out.strokes++;
    }
    if (e.t === "paint" && (!Number.isSafeInteger(e.n) || (e.n as number) < 1)) {
      return "Paint event covers no cells.";
    }
    if (e.t === "intent") out.intents++;

    if (e.w === undefined || e.w === null || e.w === "") {
      out.writes.push([]);
    } else {
      const parsed = parseWrites(e.w as string);
      if (!parsed) return "That event's write ledger does not decode.";
      runs += parsed.length;
      if (runs > MAX_RUNS_PER_BATCH) return "Too many writes in one envelope.";
      out.writes.push(parsed);
    }

    if (out.events === 0) out.firstAt = e.at;
    out.events++;
    out.lastAt = e.at;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The verified envelope                                               */
/* ------------------------------------------------------------------ */

export type AttestResult =
  | { ok: true; tally: AttestTally; receipt: string; nonce: string; art: string | undefined }
  | { ok: false; status: number; error: string };

/**
 * Verify one envelope, replay it, and advance the tally.
 *
 * The replay is the whole point of the function. `prev` carries the grid every
 * previously attested write has built up; this batch's ledgers are applied to a
 * copy of it in event order; and if the client asked for feedback by attaching
 * a canvas, that canvas must be exactly what came out. A batch that paints
 * without showing its canvas is refused too — otherwise the ledger could be
 * advanced blind and reconciled later.
 *
 * `art` is handed back re-encoded from the server's own replay rather than
 * echoed from the request. They are equal by the check immediately above; the
 * caller should still be scoring the grid this module vouched for, not the
 * string the client sent.
 */
export async function verifyAttest(
  secret: string,
  runId: string,
  idx: number,
  body: Record<string, unknown>,
  now: number,
): Promise<AttestResult> {
  if (body.v !== ENVELOPE_VERSION) {
    return {
      ok: false,
      status: 400,
      error: `This attestation envelope is version ${ENVELOPE_VERSION}. Reload the page.`,
    };
  }
  if (body.idx !== idx) return { ok: false, status: 409, error: "That is not the open puzzle." };

  // An absent receipt is the first batch of an issue, not an error.
  const fresh = body.receipt === undefined || body.receipt === null || body.receipt === "";
  const sealed = fresh
    ? { tally: { ...EMPTY_TALLY }, grid: emptyGrid() }
    : await unseal(secret, runId, idx, body.receipt);
  if (!sealed) return { ok: false, status: 400, error: "That attestation receipt is not ours." };
  const prev = sealed.tally;

  if (!(await nonceOk(secret, runId, idx, prev.seq, String(body.nonce ?? ""), now))) {
    return { ok: false, status: 400, error: "That attestation nonce is stale or wrong." };
  }

  const batch = checkBatch(body.events, prev, now);
  if (typeof batch === "string") return { ok: false, status: 400, error: batch };

  const grid = Int8Array.from(sealed.grid) as Grid;
  let cells = 0;
  for (const runs of batch.writes) cells += applyWrites(grid, runs);

  const showed = body.art !== undefined && body.art !== null && body.art !== "";
  if (cells > 0 && !showed) {
    return { ok: false, status: 400, error: "An envelope that paints must show what it painted." };
  }
  if (showed) {
    const shown = decodeGrid(body.art);
    if (!shown) return { ok: false, status: 400, error: "That canvas is not a canvas." };
    if (!sameGrid(shown, grid)) {
      return {
        ok: false,
        status: 409,
        error: "The strokes in that envelope do not paint that canvas.",
      };
    }
  }

  const tally: AttestTally = {
    seq: prev.seq + 1,
    events: prev.events + batch.events,
    strokes: prev.strokes + batch.strokes,
    intents: prev.intents + batch.intents,
    firstAt: prev.firstAt || batch.firstAt,
    lastAt: batch.lastAt,
    writes: prev.writes + cells,
    filled: countFilled(grid),
    bound: false,
  };

  return {
    ok: true,
    tally,
    receipt: await signReceipt(secret, runId, idx, tally, grid),
    nonce: await nonceFor(secret, runId, idx, tally.seq, now),
    art: showed ? encodeGrid(grid) : undefined,
  };
}

/**
 * The submit gate. Returns the complaint, or `null` when the tally clears.
 *
 * Freshness is checked against the *client's* clock for `lastAt`, which is
 * unverifiable — but the tally it sits in was only ever advanced by real server
 * round trips, so an agent that fakes a recent timestamp has still made every
 * one of those calls. The check is here to stop a receipt banked hours ago from
 * being spent on a puzzle solved by other means since.
 *
 * `bound` is set by `bindReceipt`, never by anything the client
 * sends. It is deliberately *not* "the ledger paints a full grid": submitting
 * an unfinished board is documented, expected play — it is the observation
 * channel — so the requirement is that the strokes paint whatever is being
 * submitted, complete or not.
 */
export function gateSubmit(t: AttestTally, now: number): string | null {
  if (t.strokes < GATE.strokes) return "That grid did not arrive by painting.";
  if (t.events < GATE.events) return "Not enough attested interaction to bank this.";
  if (t.intents < GATE.intents) return "No submit was ever pressed.";
  if (t.lastAt - t.firstAt < GATE.spanMs) return "That session is too short to have happened.";
  if (now - t.lastAt > GATE.freshMs) return "That attestation has gone stale. Keep playing.";
  if (!t.bound) return "That grid is not the one your attested strokes painted.";
  return null;
}
