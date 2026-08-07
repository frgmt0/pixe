/**
 * The wire format, in one place, for all three sides of the benchmark: the
 * server that issues puzzles, the browser client an agent drives, and the
 * agent's own solver. Nothing here may reach for a Node built-in — this module
 * is loaded unchanged on Bun, in the browser, and in a Cloudflare Worker.
 *
 * Two rules govern everything below.
 *
 * The server never trusts a body. Every field that crosses the wire has a
 * runtime validator here, not a cast at the call site, because a cast is a
 * comment that the type checker happens to believe.
 *
 * Time, request counts and solve validity are measured here; names and token
 * counts are whatever the run says they are. `wall_ms` — issue to accepted —
 * is the spine of the benchmark precisely because it needs no cooperation from
 * the agent and cannot be reported low. `config`, `cost_micro` and the token
 * fields are declarations, kept in separately named nullable columns so that no
 * aggregate can quietly blend a measurement with a claim. There is no
 * verification of the declared fields and none is planned; that is a scoping
 * decision, not a gap.
 *
 * `harness` sits between the two: nothing verifies the string either, but it is
 * the only identity in the system a *human* stated, through pairing, rather
 * than the run stating it about itself.
 */

import { decodeGrid, encodeGrid } from "./codec";
import { CELLS, HUES } from "./palette";
import type { Grid } from "./rules";

/** Bumped when a field changes meaning. Returned on registration so a solver
 *  written against an older spec fails loudly rather than subtly. */
export const PROTOCOL_VERSION = 1;

/** The whole point of the projection columns: how many boards exist. */
export const PUZZLE_UNIVERSE = 1_000_000;

const MS_PER_HOUR = 3_600_000;

/* ------------------------------------------------------------------ */
/* Storage rows — these mirror the SQL in server/store.ts exactly       */
/* ------------------------------------------------------------------ */

/** `pending` is a registered run whose human has not vouched for it yet. It
 *  holds a device code and cannot be issued a puzzle until pairing completes. */
export type RunStatus = "pending" | "open" | "closed" | "void";

export type IssueOutcome = "solved" | "abandoned";

/**
 * A benchmark run. This is what replaced the user account: no password, no
 * email.
 *
 * This is the single definition of the row — `server/store.ts` re-exports it
 * rather than declaring its own, because two copies of a shape this wide drift
 * silently and the drift shows up as a runtime mismatch rather than a type
 * error. It is a *type*, so nothing here is shipped to a browser; the rule that
 * keeps `secret` out of a response is that responses are built from explicit
 * projections, never from spreading a row.
 */
export interface RunRow {
  id: string;
  /** Server-only. Seeds the chained sequence; never leaves the database. */
  secret: string;
  /**
   * The benchmarked identity, vouched for by a human at pairing. There is no
   * `model` field on purpose: a harness with subagents may drive several, so a
   * single model string is ill-defined rather than merely unverifiable, and a
   * sortable column of them would read as a model leaderboard that a harness
   * benchmark cannot honestly produce. `config` is prose for that setup.
   */
  harness: string | null;
  config: string | null;
  /** Null until a human completes pairing. */
  operator_id: string | null;
  dialect: string;
  created_at: number;
  last_at: number;
  status: RunStatus;
}

/** At most one row per run has `closed_at IS NULL` — the single open puzzle. */
export interface IssueRow {
  run_id: string;
  idx: number;
  puzzle_key: string;
  issued_at: number;
  closed_at: number | null;
  outcome: IssueOutcome | null;
}

export interface RunSolveRow {
  id: number;
  run_id: string;
  idx: number;
  puzzle_key: string;
  points: number;
  bonds: number;
  difficulty: number;

  wall_ms: number;
  api_calls: number;
  /** Requests that showed this agent how the board reacted. See `probes_per_solve`. */
  probes: number;
  events: number;

  tokens_in: number | null;
  tokens_out: number | null;
  cost_micro: number | null;

  art: string;
  share_id: string;
  created_at: number;
}

/** `id` is assigned by the insert, so it is the one column a caller cannot supply. */
export type NewRunSolve = Omit<RunSolveRow, "id">;

/**
 * One row of the benchmark table. Aggregated per run, never per model — two
 * runs of the same model are two data points, not one averaged claim.
 *
 * `median_wall_ms` is the headline. Everything above it in this interface is
 * identity the run declared about itself; everything from `solved` down to
 * `api_calls_per_solve` was watched by the server; the two token columns are
 * optional and rank nothing at all.
 */
export interface BenchRow {
  run_id: string;
  /** Vouched for by a human at pairing. `config` is prose and ranks nothing. */
  harness: string | null;
  config: string | null;
  status: RunStatus;

  solved: number;
  points: number;
  bonds: number;

  /**
   * The benchmark, and the basis of the projection.
   *
   * Total time across every closed issue — abandoned boards included — divided
   * by solves. `median_wall_ms` alone was gameable: abandoning starts a fresh
   * clock, so a run that dropped every hard board and banked only easy ones
   * posted a better per-solve time than one that ground through everything it
   * was dealt. Charging abandoned work to the numerator while it contributes
   * nothing to the denominator is what makes shopping cost more than it saves.
   */
  effective_ms_per_solve: number;
  abandoned: number;
  abandon_rate: number;

  /**
   * Looks at the board per solve — attest batches plus rejected submits, over
   * the boards that were banked.
   *
   * The capacity-independent half of the benchmark, and the one that measures
   * deduction rather than infrastructure. Wall clock conflates how well an
   * agent reasons with how fast its provider happened to be serving that
   * afternoon; a congested endpoint cannot change how many times an agent had
   * to look at the board before it knew the answer. It is meaningful precisely
   * because the stroke ledger makes a probe cost a real painting session — you
   * cannot probe a board you did not paint.
   */
  probes_per_solve: number;

  /** Server-measured, issue to accepted, over the boards that were banked.
   *  Honest for "how fast when it lands", but see `effective_ms_per_solve`. */
  median_wall_ms: number;
  p90_wall_ms: number;

  /** Declared by the run. Null when unreported — never zero, never imputed. */
  tokens_per_solve: number | null;
  cost_per_solve_micro: number | null;
  /**
   * Of `solved` solves, how many carried each declared figure. "$0.02 per
   * solve" from three of forty solves is a different number from the same
   * figure over all forty, and the UI cannot say so unless the API tells it.
   */
  tokens_reported: number;
  cost_reported: number;

  /** Serial wall-clock projection over the whole puzzle space. Not throughput. */
  projected_1m_hours: number;
  projected_1m_cost_usd: number | null;

  first_at: number;
  last_at: number;
}

/**
 * A solve joined to the run that produced it, for the gallery and share pages.
 *
 * `dialect` is carried so the share page can reveal the laws the player
 * actually fought rather than the base generator's. It is the run's salt and
 * must never be projected into a response: the salt is per-run, so handing it
 * out for one finished board would hand over every other board in that run.
 * The route returns the derived rules instead.
 */
export type ArtRow = RunSolveRow & { harness: string | null; config: string | null; dialect: string };

/** One dot on the scatter plots. Deliberately flat — charts should not have to
 *  join anything to render a point. */
export interface ChartPoint {
  run_id: string;
  harness: string | null;
  config: string | null;
  idx: number;
  difficulty: number;
  points: number;
  /** Server-measured. */
  wall_ms: number;
  probes?: number;
  /** Declared by the run, null when unreported. */
  tokens_in: number | null;
  tokens_out: number | null;
  cost_micro: number | null;
  /**
   * Columns the projection may or may not carry. Optional rather than absent so
   * a chart that wants one starts working the moment it is added to the SELECT,
   * and reports nothing rather than crashing until then.
   */
  bonds?: number;
  api_calls?: number;
  events?: number;
  created_at?: number;
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

export const RUN_COOKIE = "pixe_run";

/** A run is a session that outlives a long benchmark; a day is generous
 *  without keeping a bearer token alive forever. */
export const RUN_COOKIE_MAX_AGE = 60 * 60 * 24;

export const RUN_ID_LENGTH = 16;
export const RUN_TOKEN_LENGTH = 32;

const RUN_ID_RE = /^[A-Za-z0-9_-]{16}$/;
const RUN_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

export const isRunId = (v: unknown): v is string => typeof v === "string" && RUN_ID_RE.test(v);

export function runCookie(token: string, secure: boolean): string {
  const parts = [
    `${RUN_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${RUN_COOKIE_MAX_AGE}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export const clearRunCookie = (secure: boolean) =>
  `${RUN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;

/**
 * Both forms are accepted because both are natural: the page picks up the
 * HttpOnly cookie for free, while a Playwright script that also talks to the
 * API directly would rather set a header than manage a cookie jar.
 *
 * The header wins when both are present. A script that has just registered a
 * fresh run and is sending its token explicitly should not be silently
 * answered as whatever stale run the browser profile still has a cookie for.
 */
export function runTokenFrom(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = /^Bearer[ \t]+([A-Za-z0-9._~+/-]+=*)$/.exec(auth.trim());
    if (m && RUN_TOKEN_RE.test(m[1]!)) return m[1]!;
  }
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== RUN_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return RUN_TOKEN_RE.test(value) ? value : null;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The chained sequence                                                */
/* ------------------------------------------------------------------ */

/**
 * A run does not choose its puzzles. The key for rung `n+1` is derived from
 * the digest of the *accepted* grid for rung `n`, so the board you have not
 * solved yet is not merely withheld — it is not computable. Batching a
 * thousand puzzles is arithmetically unavailable rather than detected and
 * punished, which is the difference between an anti-cheat rule and an
 * anti-cheat mechanism.
 *
 * A `chainLabel` helper used to live here to keep the signed string in one
 * place. It was deleted rather than fixed: nothing on the server called it, and
 * it had drifted into describing a different scheme from the real one — it
 * indexed the digest by the rung being issued rather than the rung that
 * produced it, and its comment claimed an abandoned rung re-rolls in place when
 * abandoning in fact advances. An unused second opinion about a security-
 * critical string is worse than no opinion. `keyAt`/`nextKey` in
 * `server/runs.ts` are the derivation of record.
 */

/**
 * Takes a `Grid`, not a string, on purpose. The codec accepts non-canonical
 * encodings — `a1a1` decodes the same as `a2` — so digesting whatever text the
 * client sent would let a solver re-encode an accepted solution over and over
 * and shop for the next puzzle key. Re-encoding here makes that unavailable.
 */
export async function solutionDigest(grid: Grid): Promise<string> {
  const bytes = new TextEncoder().encode(encodeGrid(grid));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  let out = "";
  for (const b of new Uint8Array(hash)) out += b.toString(16).padStart(2, "0");
  return out;
}

/* ------------------------------------------------------------------ */
/* Request and response bodies                                         */
/* ------------------------------------------------------------------ */

export type ErrorCode =
  | "bad_request"
  | "no_run"
  | "run_closed"
  | "no_open_issue"
  | "bad_grid"
  | "attestation_required"
  | "attestation_invalid"
  | "rate_limited"
  | "server_error";

export interface ErrorBody {
  error: string;
  code: ErrorCode;
}

/**
 * POST /api/run.
 *
 * Deliberately empty. Registration used to carry `agent` and `model`, and both
 * are gone: `agent` was the harness collected a second time from the less
 * trustworthy party, and a single `model` string is ill-defined for a harness
 * that drives several at once. Identity now arrives once, at pairing, from the
 * human — so there is nothing left for a run to say about itself here, and the
 * body an agent sends is `{}`.
 */
export type RegisterRun = Record<string, never>;

export interface RunRegistered {
  protocol: number;
  runId: string;
  /** Also set as an HttpOnly cookie. Returned in the body as well because a
   *  script driving the API alongside the browser wants the header form. */
  runToken: string;
  dialect: string;
}

/** GET /api/run/me */
export interface RunState {
  protocol: number;
  runId: string;
  /** Null until a human has vouched for the run. */
  harness: string | null;
  config: string | null;
  dialect: string;
  status: RunStatus;
  createdAt: number;
  lastAt: number;
  solved: number;
  points: number;
  bonds: number;
  /** The single open rung, or null when the run is between puzzles. */
  open: { idx: number; key: string; issuedAt: number } | null;
}

/** One palette entry, sent with the board so a solver never has to guess hue ids. */
export interface Swatch {
  id: number;
  name: string;
  hex: string;
}

export const boardPalette = (): Swatch[] => HUES.map((h) => ({ id: h.id, name: h.name, hex: h.hex }));

/**
 * Everything an agent is allowed to see about the open puzzle.
 *
 * Note what is absent: the seed, the zone scheme, and the laws. The old client
 * re-derived all three locally to drive the glow, which meant anyone reading
 * devtools could read the rules — tolerable when it only spoiled one player's
 * own discovery, fatal once a leaderboard is a benchmark. So the two feedback
 * channels the game has always had are now *sent* rather than recomputed:
 * `badCells` is the cell flash, `hotHues` is the swatch buzz. Neither names a
 * law, exactly as before.
 */
export interface BoardView {
  idx: number;
  key: string;
  title: string;
  size: number;
  cells: number;
  palette: Swatch[];
  /** Points on offer for a clean solve. */
  points: number;
  issuedAt: number;

  /** The last grid the server accepted for this rung, run-length encoded. */
  art: string;
  filled: number;
  /** Cells breaking a placement law, as of the last submitted grid. */
  badCells: number[];
  /** Hues whose counting law is unhappy. Says which colour, never why. */
  hotHues: number[];
  /** True only when the grid is complete and every law holds. */
  solved: boolean;
  bonds: number;

  /** Server-measured cost of this rung so far. Visible so the meter is never a surprise. */
  apiCalls: number;
  events: number;
}

/** POST /api/next */
export interface NextIssued {
  /** Duplicated from `board` because the contract's shape is `{idx, key, board}`
   *  and a caller that only wants the key should not have to reach inside. */
  idx: number;
  key: string;
  board: BoardView;
}

/**
 * Self-reported token and cost accounting. Cumulative for the current rung,
 * resent on every submit; the server keeps the last value it saw and banks it
 * when the rung is accepted. Cumulative-and-resent rather than incremental so
 * a dropped request costs accuracy for one submit instead of corrupting the
 * running total.
 *
 * Entirely optional and entirely unranked. Reporting buys a run two extra
 * columns on the chart and nothing else — no score, no placement, no badge. A
 * run that reports nothing is a first-class participant with two blank cells.
 */
export interface MeterReport {
  tokensIn: number | null;
  tokensOut: number | null;
  costMicro: number | null;
}

export const meterToRow = (m: MeterReport | null) => ({
  tokens_in: m?.tokensIn ?? null,
  tokens_out: m?.tokensOut ?? null,
  cost_micro: m?.costMicro ?? null,
});

/**
 * The hole left for browser-event attestation. The envelope is versioned and
 * opaque: this module guarantees only that `payload` is a bounded string and
 * that it is aimed at a particular rung. What is inside, and whether it is
 * good, belongs to server/attest.ts — keeping the contents out of the shared
 * wire type is what lets the attestation scheme change without a protocol bump.
 */
export interface AttestEnvelope {
  v: number;
  /** The rung this evidence covers. Evidence from rung 3 must not pay for rung 4. */
  idx: number;
  payload: string;
}

export const MAX_ATTEST_PAYLOAD = 32 * 1024;

/** POST /api/attest */
export interface AttestResult {
  ok: boolean;
  /** Attested events counted for the open rung so far. */
  events: number;
}

/** POST /api/submit */
export interface SubmitBody {
  art: string;
  meter?: MeterReport;
  attest?: AttestEnvelope;
}

export interface ParsedSubmit {
  art: string;
  grid: Grid;
  meter: MeterReport | null;
  attest: AttestEnvelope | null;
}

/**
 * Submit is also the observation channel, and that is the central design
 * choice of the whole loop. A grid that is not yet a solution is not an error:
 * it comes back 200 with the flashing cells and buzzing swatches, because that
 * feedback *is* the game. What stops this from being free brute force is that
 * every submit is counted in `api_calls` and every second between issue and
 * acceptance is counted in `wall_ms`. Probing is allowed and priced.
 *
 * 4xx is reserved for grids the server could not read at all.
 */
export type SubmitResult = SubmitRejected | SubmitAccepted;

export interface SubmitRejected {
  accepted: false;
  idx: number;
  key: string;
  filled: number;
  empty: number;
  badCells: number[];
  hotHues: number[];
  bonds: number;
  apiCalls: number;
  events: number;
}

export interface SubmitAccepted {
  accepted: true;
  idx: number;
  key: string;
  points: number;
  bonds: number;
  parBonds: number;
  difficulty: number;
  shareId: string;
  /** Server-measured, authoritative. */
  wallMs: number;
  apiCalls: number;
  events: number;
  /** Totals for the run after banking this solve. */
  solved: number;
  totalPoints: number;
}

/** GET /api/bench */
export interface BenchBody {
  rows: BenchRow[];
  /** So the client never hardcodes the same 1_000_000 twice. */
  universe: number;
  /** Solve rows the aggregate saw, and whether that hit the cap. A truncated
   *  table is a different claim from a complete one and has to say so. */
  pointsConsidered: number;
  truncated: boolean;
  generatedAt: number;
}

/** GET /api/bench/points */
export interface BenchPointsBody {
  points: ChartPoint[];
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string; code: ErrorCode };

const bad = (error: string, code: ErrorCode = "bad_request"): Parsed<never> => ({ ok: false, error, code });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Rejects the whole float zoo — NaN, Infinity, 1e309, 3.5, -0.0001 — in one place. */
function intIn(v: unknown, min: number, max: number): number | null {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) return null;
  return v >= min && v <= max ? v : null;
}

export const MAX_LABEL = 48;

/**
 * Harness and config are rendered straight into the public benchmark table, so
 * they are cut to printable characters on a single line and capped. Nothing
 * here is about correctness — it is about a run named with 4KB of newlines not
 * being able to own the leaderboard.
 *
 * `label` is exported because the pairing handler sanitises what a human typed
 * with exactly this rule. One sanitiser, or there are eventually two subtly
 * different ones.
 */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\ufeff]/g;

export function label(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const clean = v.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
  if (clean.length === 0 || clean.length > MAX_LABEL) return null;
  return clean;
}

/**
 * Registration declares no identity, so this validates an absence: the body has
 * to be a JSON object and nothing in it is read.
 *
 * A `harness` in the body is ignored rather than 400'd, and that stays true now
 * that it is the only identity in the system. The endpoint is the first thing
 * an unfamiliar solver calls, and failing it over a field the server does not
 * need would cost a run its whole session to make a point the table already
 * makes: the harness shown is the one a human vouched for, and there is no
 * request that changes it.
 */
export function parseRegisterRun(body: unknown): Parsed<RegisterRun> {
  if (!isRecord(body)) return bad("Send a JSON object. `{}` is the whole body.");
  return { ok: true, value: {} };
}

/** A trillion tokens and a million dollars are both far past any real run, and
 *  both are small enough that a sum over a run stays a safe integer. */
const MAX_TOKENS = 1e12;
const MAX_COST_MICRO = 1e12;

function parseMeter(v: unknown): Parsed<MeterReport | null> {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (!isRecord(v)) return bad("meter must be an object.");

  const field = (name: "tokensIn" | "tokensOut" | "costMicro", max: number): number | null | false => {
    const raw = v[name];
    if (raw === undefined || raw === null) return null;
    const n = intIn(raw, 0, max);
    return n === null ? false : n;
  };

  const tokensIn = field("tokensIn", MAX_TOKENS);
  if (tokensIn === false) return bad("meter.tokensIn must be a non-negative integer.");
  const tokensOut = field("tokensOut", MAX_TOKENS);
  if (tokensOut === false) return bad("meter.tokensOut must be a non-negative integer.");
  const costMicro = field("costMicro", MAX_COST_MICRO);
  if (costMicro === false) return bad("meter.costMicro must be a non-negative integer of micro-USD.");

  if (tokensIn === null && tokensOut === null && costMicro === null) return { ok: true, value: null };
  return { ok: true, value: { tokensIn, tokensOut, costMicro } };
}

/** Shape only. Whether the payload is genuine is server/attest.ts's question. */
export function parseAttestEnvelope(v: unknown): Parsed<AttestEnvelope> {
  if (!isRecord(v)) return bad("Attestation envelope must be an object.", "attestation_invalid");
  const version = intIn(v.v, 1, 255);
  if (version === null) return bad("Attestation envelope needs a version.", "attestation_invalid");
  const idx = intIn(v.idx, 0, PUZZLE_UNIVERSE);
  if (idx === null) return bad("Attestation envelope needs the rung it covers.", "attestation_invalid");
  if (typeof v.payload !== "string" || v.payload.length === 0) {
    return bad("Attestation payload must be a string.", "attestation_invalid");
  }
  if (v.payload.length > MAX_ATTEST_PAYLOAD) {
    return bad("Attestation payload is too large.", "attestation_invalid");
  }
  return { ok: true, value: { v: version, idx, payload: v.payload } };
}

/**
 * Round-trips the grid through the decoder rather than trusting the string, so
 * a malformed blob is rejected here and never reaches the validator or the
 * database. Returns the decoded grid too — the caller needs it, and asking for
 * it back is one fewer place to forget.
 */
export function parseSubmit(body: unknown): Parsed<ParsedSubmit> {
  if (!isRecord(body)) return bad("Send a JSON object with an art field.");
  const grid = decodeGrid(body.art);
  if (!grid) return bad("That canvas is not a canvas.", "bad_grid");

  const meter = parseMeter(body.meter);
  if (!meter.ok) return meter;

  let attest: AttestEnvelope | null = null;
  if (body.attest !== undefined && body.attest !== null) {
    const parsed = parseAttestEnvelope(body.attest);
    if (!parsed.ok) return parsed;
    attest = parsed.value;
  }

  return { ok: true, value: { art: body.art as string, grid, meter: meter.value, attest } };
}

/* ------------------------------------------------------------------ */
/* Metrics — one definition, so the table and the charts cannot drift   */
/* ------------------------------------------------------------------ */

/** Nearest-rank, so every reported percentile is an observation that actually
 *  happened rather than an interpolation between two runs. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * Serial wall clock to clear the whole puzzle space at this run's median pace.
 * It is a projection of one agent working one board at a time, which is the
 * only projection the chained sequence permits — there is no parallel version
 * of this number, and the UI must not let anyone read it as throughput.
 */
export const projected1mHours = (medianWallMs: number) =>
  (medianWallMs * PUZZLE_UNIVERSE) / MS_PER_HOUR;

/**
 * Micro-USD per solve times a million puzzles is dollars, exactly — the two
 * factors of 1e6 cancel. Written as the full expression anyway, because the
 * coincidence is a fact about the units and not something to lean on.
 */
export const projected1mCostUsd = (costPerSolveMicro: number) =>
  (costPerSolveMicro / 1_000_000) * PUZZLE_UNIVERSE;

/**
 * Benchmark rows are built in `server/bench.ts`, not here.
 *
 * A `summarizeRun` lived at this spot and computed the same table from solves
 * alone. It had to go: a row's headline figure is now effective time per solve,
 * which charges the run for boards it abandoned, and abandoned boards leave no
 * solve row to read. Summarising from `run_solves` cannot see them by
 * construction, so the honest version needs `issues` too and belongs on the
 * server. The formulas above stay shared, which is what actually keeps the
 * table and the charts from drifting.
 */

/**
 * The two rankings, and they answer different questions.
 *
 * They live here rather than in `server/bench.ts` for the reason every other
 * formula does: the server sorts the response and the table re-sorts it when a
 * reader toggles a column, and two implementations of "which run is ahead"
 * would eventually disagree about the same rows on the same page.
 *
 * A run that has banked nothing sorts last under both, ahead of any comparison
 * of per-solve figures — dividing by zero solves produces a number, and it is
 * always a flattering one.
 */

/**
 * Throughput. Sorts on effective time rather than the median, which is
 * shoppable by abandoning hard boards.
 *
 * The default, because the projection to a million puzzles is a throughput
 * question and capacity honestly belongs in that answer.
 */
export function byEffectiveTime(a: BenchRow, b: BenchRow): number {
  if (a.solved === 0 || b.solved === 0) return b.solved - a.solved;
  return (
    a.effective_ms_per_solve - b.effective_ms_per_solve ||
    b.solved - a.solved ||
    a.first_at - b.first_at
  );
}

/**
 * Deduction. Looks at the board per solve, and capacity-independent: a busy
 * endpoint changes how long an agent takes, never how many times it had to look
 * before it knew the answer. Meaningful because the stroke ledger makes a probe
 * cost a real painting session — you cannot probe a board you did not paint.
 */
export function byProbes(a: BenchRow, b: BenchRow): number {
  if (a.solved === 0 || b.solved === 0) return b.solved - a.solved;
  return (
    a.probes_per_solve - b.probes_per_solve ||
    b.solved - a.solved ||
    a.effective_ms_per_solve - b.effective_ms_per_solve
  );
}

export const chartPointOf = (
  row: RunSolveRow,
  run: Pick<RunRow, "harness" | "config">,
): ChartPoint => ({
  run_id: row.run_id,
  harness: run.harness,
  config: run.config,
  idx: row.idx,
  difficulty: row.difficulty,
  points: row.points,
  wall_ms: row.wall_ms,
  bonds: row.bonds,
  api_calls: row.api_calls,
  events: row.events,
  tokens_in: row.tokens_in,
  tokens_out: row.tokens_out,
  cost_micro: row.cost_micro,
  created_at: row.created_at,
});

/** Guards a `BoardView.badCells` array before it is rendered or reasoned over. */
export const isCellIndex = (v: unknown): v is number => intIn(v, 0, CELLS - 1) !== null;
