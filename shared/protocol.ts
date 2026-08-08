/**
 * The wire format, in one place, for both sides of the benchmark: the server
 * that issues puzzles and the agent that answers them. Nothing here may reach
 * for a Node built-in — this module is loaded unchanged on Bun, in the browser,
 * and in a Cloudflare Worker.
 *
 * Two rules govern everything below.
 *
 * The server never trusts a body. Every field that crosses the wire has a
 * runtime validator here, not a cast at the call site, because a cast is a
 * comment that the type checker happens to believe.
 *
 * Time, request counts and solve validity are measured here; identity and token
 * counts are whatever the run says they are. `wall_ms` — issue to accepted — is
 * the spine of the benchmark precisely because it needs no cooperation from the
 * agent and cannot be reported low. `model`, `provider`, `config`, `cost_micro`
 * and the token fields are declarations, kept in separately named columns so
 * that no aggregate can quietly blend a measurement with a claim. There is no
 * verification of the declared fields and none is planned; that is a scoping
 * decision, not a gap.
 *
 * pixe is a pure API benchmark. There is no browser in the measured path, no
 * human vouching for a run, and no attestation of input events. Everything the
 * server knows about an agent is either something it timed itself or something
 * the agent typed into a registration body.
 */

import { decodeGrid, encodeGrid } from "./codec";
import { CELLS, EMPTY, GRID, HUES, hueName } from "./palette";
import { emptyGrid, type Grid } from "./rules";

/** Bumped when a field changes meaning. Returned on registration so a solver
 *  written against an older spec fails loudly rather than subtly.
 *
 *  2 is the pure-API protocol: pairing, attestation and exec-binding are gone,
 *  puzzles are issued and answered as JSON under `/api/bench/runs`. */
export const PROTOCOL_VERSION = 2;

/** The whole point of the projection columns: how many boards exist. */
export const PUZZLE_UNIVERSE = 1_000_000;

const MS_PER_HOUR = 3_600_000;

/* ------------------------------------------------------------------ */
/* Storage rows — these mirror the SQL in server/store.ts exactly       */
/* ------------------------------------------------------------------ */

/** There is no `pending` any more. A run is playable the moment it is created:
 *  nothing has to be arranged out of band before an agent can draw a board. */
export type RunStatus = "open" | "closed" | "void";

export type IssueOutcome = "solved" | "abandoned";

/**
 * A benchmark run. This is what replaced the user account: no password, no
 * email, no human.
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
   * The declared identity of the thing being benchmarked, and the two columns a
   * leaderboard groups on. Required at registration and never verified — see
   * `docs/THREAT-MODEL.md`, which says so in those words.
   */
  model: string;
  provider: string;
  /** Free prose about the setup — "8 parallel painters", "planner + subagents". */
  config: string | null;
  dialect: string;
  created_at: number;
  last_at: number;
  status: RunStatus;
  /**
   * `1` iff the registration request carried the maintainer's own secret in
   * `X-Pixe-Verified-Key`, compared in constant time. Stored as the SQLite/D1
   * native `INTEGER` rather than `boolean` so this row is exactly what the
   * database returns; wire responses convert it. This is a vouch about *where
   * the run was started*, nothing more — it does not check that the declared
   * model is accurate, only that whoever registered the run held the
   * deployment's own key. A server with no `PIXE_VERIFIED_KEY` configured can
   * never produce a `1` here, for anyone.
   */
  verified: number;
}

/**
 * At most one row per run has `closed_at IS NULL` — the single open puzzle.
 *
 * `phase` and `phase_grids` are what make a multi-phase rung one issue rather
 * than several. The clock is `issued_at` and it does not restart between
 * phases; `phase_grids` holds the accepted grid for every phase already
 * finished, JSON-encoded through the run-length codec, because phase k+1's laws
 * are *derived from them* and re-validating the rung from the seed later needs
 * the same inputs the derivation originally had.
 */
export interface IssueRow {
  run_id: string;
  idx: number;
  puzzle_key: string;
  issued_at: number;
  closed_at: number | null;
  outcome: IssueOutcome | null;
  /** 1-based. A single-phase rung stays at 1 for its whole life. */
  phase: number;
  /** JSON array of run-length grids, one per accepted phase. Null until one is. */
  phase_grids: string | null;
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
  /** Submits that came back unaccepted. See `probes_per_solve`. */
  probes: number;

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
 * One row *per run*. This is the unit `/api/bench` aggregates from — two runs
 * of the same model are two data points, not one averaged claim — and it is
 * still what `/api/bench?members=1` nests under each model/provider group and
 * what `/api/bench/points` keys its chart points to. The model-grouped table
 * itself is `BenchGroupRow`, built by folding these together.
 *
 * `effective_ms_per_solve` is the headline. Everything above it in this
 * interface is identity the run declared about itself; everything from `solved`
 * down to `p90_wall_ms` was watched by the server; the two token columns are
 * optional and rank nothing at all.
 */
export interface BenchRow {
  run_id: string;
  /** Declared at registration, unverified. */
  model: string;
  provider: string;
  config: string | null;
  status: RunStatus;
  /**
   * Whether *this run* was started with the maintainer's registration key. Not
   * a claim about the model — see `RunRow.verified` — but it is what lets a
   * model-grouped row say "verified" honestly: a group is verified iff at
   * least one of its runs is, and the representative is chosen from among them
   * when it can be.
   */
  verified: boolean;

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
   * How many times the agent had to look at the board per solve — that is,
   * submits that came back unaccepted, over the boards that were banked.
   *
   * The capacity-independent half of the benchmark, and the one that measures
   * deduction rather than infrastructure. Wall clock conflates how well an
   * agent reasons with how fast its provider happened to be serving that
   * afternoon; a congested endpoint cannot change how many times an agent had
   * to look at the board before it knew the answer.
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
 * One row of the benchmark *table* — one per `(model, provider)`, which is
 * what a leaderboard actually is. `GET /api/bench` returns these, ranked by
 * `byGroupProgress`: most of the ladder banked wins, wall clock is the tiebreak.
 * That ordering is deliberate, not incidental — the ladder is a fixed 500
 * boards and brutally hard, so how far a model got is the headline and how
 * fast is what settles a tie, never the other way round.
 *
 * Every scalar on this row is the *representative* run's own figure — chosen
 * as the best run in the group, verified runs preferred outright, never an
 * average across the group. Averaging `effective_ms_per_solve` across runs of
 * wildly different skill and luck would produce a number that describes no
 * run that actually played; naming one real run's numbers is honest about what
 * they are. `runs` and `verifiedRuns` are the only two fields that describe
 * the *group* rather than the representative.
 *
 * Field order follows the ranking's own priority: identity, then verification,
 * then group size, then progress (`solves`, out of the fixed 500-board ladder),
 * then the pace figures that only ever break a tie.
 */
export interface BenchGroupRow {
  model: string;
  provider: string;
  /**
   * True iff *any* run in the group is verified — and when it is, the
   * representative is chosen from among the verified runs only, so this is
   * also the representative's own `verified`. A model cannot borrow another
   * run's vouch: the number the row reports is a real verified run's number.
   */
  verified: boolean;
  /** How many runs declared this exact `(model, provider)` pair. */
  runs: number;
  /** Of `runs`, how many were verified. */
  verifiedRuns: number;

  /** The representative's rungs banked, out of the fixed `LADDER_SIZE` (500)
   *  total distinct keys — the headline column. */
  solves: number;
  totalPoints: number;

  effective_ms_per_solve: number;
  median_wall_ms: number;
  probes_per_solve: number;
  abandoned: number;
  abandon_rate: number;

  /** Declared meter *sums* over the representative run's solves — not a mean —
   *  because "how many tokens did clearing this much of the ladder cost" is
   *  the number a reader wants beside `solves`. Null when the run reported
   *  nothing at all for that figure, never zero. */
  tokensIn: number | null;
  tokensOut: number | null;
  costMicro: number | null;

  /** The representative's own setup note. Prose, ranked by nothing. */
  config: string | null;
  /**
   * The furthest chain position the representative's issues reached — cheaply
   * derivable as `max(idx)` over its solves, already fetched for everything
   * else on this row. Abandoned boards consume a chain position too, so this
   * is "how far into the ladder", not "how many boards landed" — `solves` is
   * that number. Null when the representative has no solves to derive it from,
   * which cannot currently happen since only scored runs reach this row.
   */
  maxRung: number | null;

  /** The representative run's id, so a client can ask `/api/bench/points?run=`
   *  for its chart series without a second lookup. */
  run_id: string;
  first_at: number;
  last_at: number;

  /**
   * Present only when the caller asked for it (`?members=1`). Every run in the
   * group, unfolded, in case a reader wants to see the individual runs behind
   * a model rather than just its best one. Each member is a full `BenchRow`,
   * so it carries its own `verified`.
   */
  members?: BenchRow[];
}

/**
 * A solve joined to the run that produced it, for the gallery and share pages.
 *
 * `dialect` is carried so the share page can reveal the laws the run actually
 * fought rather than the base generator's. It is the run's salt and must never
 * be projected into a response: the salt is per-run, so handing it out for one
 * finished board would hand over every other board in that run.
 */
export type ArtRow = RunSolveRow & {
  model: string;
  provider: string;
  config: string | null;
  dialect: string;
  /**
   * The accepted grids for the phases before the one `art` holds, carried from
   * the issue. A multi-phase rung's art is its *final* phase, and that phase's
   * laws are not derivable without them — a share page that re-derived phase 1
   * would print a set of laws the picture beside it never had to obey.
   */
  phase_grids: string | null;
};

/** One dot on the scatter plots. Deliberately flat — charts should not have to
 *  join anything to render a point. */
export interface ChartPoint {
  run_id: string;
  model: string;
  provider: string;
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
  created_at?: number;
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

export const RUN_COOKIE = "pixe_run";

/** A run is a session that outlives a long benchmark; a month is generous
 *  without keeping a bearer token alive forever. */
export const RUN_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export const RUN_ID_LENGTH = 16;

const RUN_ID_RE = /^[A-Za-z0-9_-]{12,24}$/;
const RUN_TOKEN_RE = /^[A-Za-z0-9_.-]{16,256}$/;

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
 * Both forms are accepted because both are natural: an HTTP client would rather
 * set a header than manage a cookie jar, while the page picks up the HttpOnly
 * cookie for free.
 *
 * The header wins when both are present. A script that has just registered a
 * fresh run and is sending its token explicitly should not be silently answered
 * as whatever stale run the browser profile still has a cookie for.
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
 * A run does not choose its puzzles. The key for rung `n+1` is derived from the
 * digest of the *accepted* grid for rung `n`, so the board you have not solved
 * yet is not merely withheld — it is not computable. Batching a thousand
 * puzzles is arithmetically unavailable rather than detected and punished,
 * which is the difference between an anti-cheat rule and an anti-cheat
 * mechanism. `keyAt`/`nextKey` in `server/runs.ts` are the derivation of record.
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
  | "open_issue"
  | "no_open_issue"
  | "bad_grid"
  | "rate_limited"
  | "not_found"
  | "server_error";

export interface ErrorBody {
  error: string;
  code: ErrorCode;
}

/**
 * POST /api/bench/runs.
 *
 * `model` and `provider` are required and are the only identity in the system.
 * Nothing checks them. They are required rather than optional because a
 * leaderboard grouped on a column that is usually null is not a leaderboard,
 * and because asking once, at registration, is the cheapest possible moment to
 * ask — an agent that cannot name its own model is not going to be able to name
 * it later either.
 */
export interface RegisterRun {
  model: string;
  provider: string;
  config: string | null;
}

export interface RunRegistered {
  protocol: number;
  runId: string;
  /** Also set as an HttpOnly cookie. Returned in the body as well because an
   *  HTTP client would rather hold the token itself than a cookie jar. */
  runToken: string;
  model: string;
  provider: string;
  config: string | null;
  /**
   * Whether this registration carried the maintainer's key in
   * `X-Pixe-Verified-Key`. Sent back so a runner that asked to be verified can
   * confirm it actually happened rather than assuming from a `201` alone — a
   * wrong or missing key still registers the run, silently unverified.
   */
  verified: boolean;
  /** A stable public *name* for the run's rule dialect, never the salt. */
  dialect: string;
  status: RunStatus;
  createdAt: number;
}

/** GET /api/bench/runs/:id (auth: runToken). */
export interface RunState {
  protocol: number;
  runId: string;
  model: string;
  provider: string;
  config: string | null;
  /** Same meaning as `RunRegistered.verified` — fixed at registration and
   *  unchanged for the run's whole life. */
  verified: boolean;
  dialect: string;
  status: RunStatus;
  createdAt: number;
  lastAt: number;
  solved: number;
  points: number;
  bonds: number;
  /** The single open rung, or null when the run is between puzzles. */
  open: { idx: number; key: string; issuedAt: number; phase: number; phases: number } | null;
}

/** One palette entry, sent with the board so a solver never has to guess hue ids. */
export interface Swatch {
  id: number;
  name: string;
  hex: string;
}

export const boardPalette = (): Swatch[] => HUES.map((h) => ({ id: h.id, name: h.name, hex: h.hex }));

/**
 * Everything an agent is entitled to know about the puzzle it was just issued,
 * and the whole of what `POST /api/bench/runs/:id/next` returns.
 *
 * Note what is absent: the seed, the dialect salt, the zone scheme, the hue set
 * and the laws. The laws are the thing being deduced; shipping any of them —
 * even as a count, even as a numeric threshold — would end the benchmark. What
 * is here is structure the agent could measure for itself in one round trip
 * anyway: how big the board is, which colours exist, and what the rung is worth.
 */
export interface PuzzleIssued {
  protocol: number;
  runId: string;
  /** Position in this run's chain. The clock for the rung starts at `issuedAt`. */
  idx: number;
  /** Ladder key, e.g. `L241`. Stable name for the board within the run's dialect. */
  key: string;
  /** `<runId>:<idx>` — globally unique, and the id to quote in a bug report. */
  puzzleId: string;
  title: string;
  width: number;
  height: number;
  cells: number;
  palette: Swatch[];
  /** Points on offer for a clean solve of **this phase**. A rung pays the sum. */
  points: number;
  /** Server clock, in epoch ms. `wall_ms` is measured from exactly this value. */
  issuedAt: number;
  /** Cells are row-major: `index = y * width + x`. Stated so nobody has to guess. */
  rowMajor: true;
  /**
   * Where this board sits in its rung's phase chain, 1-based, and how long the
   * chain is.
   *
   * How many phases there are is entitled information — an agent budgeting a
   * rung needs to know whether accepting this board ends it — and it costs
   * nothing, because a phase's laws are not derivable from its number. What is
   * absent, as ever, is anything about the laws themselves.
   */
  phase: number;
  phases: number;
  /**
   * Cells already painted, and which must come back exactly as given. Empty on
   * phase 1; on later phases these are carried over from the agent's own
   * accepted grid for the phase before. A locked cell submitted with any other
   * hue flashes, like any other placement complaint.
   */
  locked: LockedCellWire[];
}

/** One pre-filled cell, in the same coordinate language as `Flash`. */
export interface LockedCellWire {
  x: number;
  y: number;
  hue: number;
}

/**
 * A flashing cell. `{x, y}` rather than a flat index because the feedback is
 * about *where* a cell is, and an agent reasoning about neighbourhoods should
 * not have to divide by 64 to find out.
 */
export interface Flash {
  x: number;
  y: number;
}

/**
 * The two feedback channels, and nothing else. This is the whole of what the
 * server will ever tell an agent about a wrong grid.
 *
 * `flashes` is the cell channel: those cells break a placement law, because of
 * where they are or what they touch, never because of how many of them there
 * are. `buzzes` is the swatch channel: those colours have a counting law that
 * is unhappy — a quota, a per-line limit, a zone coverage floor. It names the
 * colour and never the law, never the threshold, never the direction.
 *
 * A law that is merely *unfinished* stays silent while blank cells remain. So
 * on a partial grid, two empty arrays mean "nothing you have done is definitely
 * wrong yet". On a full grid they mean solved.
 */
export interface Feedback {
  flashes: Flash[];
  buzzes: string[];
}

/** Cell indices and hue ids as the two channels are published. The engine
 *  speaks in indices and ids; the wire speaks in coordinates and colour names. */
export function feedbackFrom(badCells: Iterable<number>, hotHues: Iterable<number>): Feedback {
  const flashes: Flash[] = [];
  for (const i of badCells) flashes.push({ x: i % GRID, y: (i / GRID) | 0 });
  flashes.sort((a, b) => a.y - b.y || a.x - b.x);
  const buzzes = [...hotHues].sort((a, b) => a - b).map((h) => hueName(h));
  return { flashes, buzzes };
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
 * POST /api/bench/runs/:id/submit.
 *
 * `grid` is the answer, in any of three shapes — see `parseGrid`. `meter` is
 * optional and unranked.
 */
export interface SubmitBody {
  grid: string | string[] | number[][];
  meter?: MeterReport;
}

export interface ParsedSubmit {
  grid: Grid;
  meter: MeterReport | null;
}

/**
 * Submit is also the observation channel, and that is the central design choice
 * of the whole loop. A grid that is not yet a solution is not an error: it comes
 * back 200 with the flashing cells and buzzing swatches, because that feedback
 * *is* the game. What stops this from being free brute force is that every
 * unaccepted submit is counted as a probe and every second between issue and
 * acceptance is counted in `wall_ms`. Probing is allowed and priced.
 *
 * 4xx is reserved for grids the server could not read at all.
 */
export type SubmitResult = SubmitRejected | SubmitAccepted;

export interface SubmitRejected {
  accepted: false;
  idx: number;
  key: string;
  /** Which phase of the rung this verdict is about. */
  phase: number;
  phases: number;
  /** Painted cells and blank cells, echoed back so a truncated grid is obvious. */
  filled: number;
  empty: number;
  feedback: Feedback;
  bonds: number;
  /** Server-measured, for this rung so far. Visible so the meter is never a surprise. */
  apiCalls: number;
  probes: number;
}

/**
 * One shape for both kinds of acceptance, discriminated by `rungComplete`.
 *
 * Accepting phase k of a multi-phase rung is not the end of anything: the rung
 * stays open, the clock keeps running, and phase k+1's whole payload comes back
 * in `next` — derived, right then, from the grid that was just accepted. There
 * is deliberately no second request to fetch it. A phase handoff that took a
 * round trip would be a moment where the rung was solved but not issued, and
 * the only thing that could happen in that window is bookkeeping.
 *
 * Nothing is banked until `rungComplete` is true: not the points, not the
 * share, not the solve row. `points` is 0 and `shareId` null until then, while
 * `phasePoints` reports what the phase just accepted was worth.
 */
export interface SubmitAccepted {
  accepted: true;
  idx: number;
  key: string;
  /** The phase just accepted, and how many the rung has. */
  phase: number;
  phases: number;
  /** False while more phases remain. The rung banks on the response that says true. */
  rungComplete: boolean;
  /** True when this rung was already banked and this submit paid nothing. */
  alreadySolved: boolean;
  /** What the phase just accepted was worth. Computed from its rule weights. */
  phasePoints: number;
  /** Banked for the whole rung — the sum over its phases. 0 until `rungComplete`. */
  points: number;
  bonds: number;
  parBonds: number;
  difficulty: number;
  /** Null until the rung is complete: there is nothing to share yet. */
  shareId: string | null;
  /** Server-measured, authoritative: `issued_at` to this moment. Spans every phase. */
  wallMs: number;
  apiCalls: number;
  probes: number;
  /** Totals for the run after banking this solve. */
  solved: number;
  totalPoints: number;
  /** The next phase, issued in this same response and on the same clock. */
  next: PuzzleIssued | null;
  /**
   * The post-solve reveal, and only once the whole rung is banked. `rules` and
   * `scheme` describe the final phase; `phases` carries every phase in order,
   * so a multi-phase rung reveals all of its laws or none of them.
   */
  reveal: {
    title: string;
    scheme: unknown;
    rules: unknown[];
    phases: { phase: number; title: string; scheme: unknown; rules: unknown[] }[];
  } | null;
}

/** POST /api/bench/runs/:id/abandon */
export interface AbandonResult {
  abandoned: number;
  heldMs: number;
  /** Abandoned time lands in `effective_ms_per_solve`'s numerator and the board
   *  adds nothing to its denominator. Restated on the wire so a runner author
   *  cannot mistake "allowed" for "free". */
  charged: true;
}

/**
 * GET /api/bench — one row per `(model, provider)`. `?members=1` adds each
 * group's individual runs under `BenchGroupRow.members`; the flag is named
 * `members` rather than `runs` because `?runs=` already means "how many rows
 * to consider" (the aggregation's own limit, unrelated to this).
 */
export interface BenchBody {
  rows: BenchGroupRow[];
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

export const MAX_LABEL = 64;

/**
 * `model`, `provider` and `config` are rendered straight into the public
 * benchmark table, so they are cut to printable characters on a single line and
 * capped. Nothing here is about correctness — it is about a run named with 4KB
 * of newlines not being able to own the leaderboard.
 */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\ufeff]/g;

export function label(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const clean = v.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
  if (clean.length === 0 || clean.length > MAX_LABEL) return null;
  return clean;
}

/**
 * Registration declares an identity, and this is the only place it is checked.
 *
 * Checked for *rendering*, not for truth: there is nothing to check a model
 * string against, and pretending otherwise with a whitelist would only mean
 * that the next model to ship could not be benchmarked until someone updated a
 * constant. A missing field is a 400 rather than a null column, because a
 * leaderboard grouped on nulls is not a leaderboard.
 */
export function parseRegisterRun(body: unknown): Parsed<RegisterRun> {
  if (!isRecord(body)) {
    return bad('Send a JSON object: {"model": "...", "provider": "..."}.');
  }
  const model = label(body.model);
  if (!model) {
    return bad(`Name the model, 1-${MAX_LABEL} printable characters. It is not verified, only recorded.`);
  }
  const provider = label(body.provider);
  if (!provider) {
    return bad(`Name the provider, 1-${MAX_LABEL} printable characters. It is not verified, only recorded.`);
  }
  if (body.config === undefined || body.config === null || body.config === "") {
    return { ok: true, value: { model, provider, config: null } };
  }
  const config = label(body.config);
  if (!config) return bad("That config note is not usable. Leave it out if unsure.");
  return { ok: true, value: { model, provider, config } };
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

/** The character an agent writes for a cell it has not painted. `.` because a
 *  blank should be visible as a blank when a row of 64 is printed to a log. */
export const BLANK_CHAR = ".";

const ROW_CHARS = "abcdefgh";

/**
 * A grid, in whichever of the three shapes the agent found natural.
 *
 * 1. `string[]` — 64 rows of 64 characters, `a`-`h` for hue 0-7 and `.` for
 *    blank. The default, because it is the one an agent can read back in a log
 *    and see the picture.
 * 2. `number[][]` — 64 rows of 64 integers, 0-7 and -1 (or `null`) for blank.
 *    For a solver that thinks in arrays and would rather not encode anything.
 * 3. `string` — the run-length codec in `shared/codec.ts`. Compact, and what
 *    the database stores.
 *
 * Three shapes rather than one is a deliberate cost: the alternative is every
 * runner author writing the same encoder, getting it subtly wrong, and blaming
 * the benchmark for a `bad_grid`. All three land in the same `Int8Array`, and
 * the server re-encodes canonically before it hashes anything, so none of them
 * is a way to steer the chain.
 */
export function parseGrid(v: unknown): Grid | null {
  if (typeof v === "string") return decodeGrid(v);
  if (!Array.isArray(v) || v.length !== GRID) return null;

  const grid = emptyGrid();
  for (let y = 0; y < GRID; y++) {
    const row = v[y];
    if (typeof row === "string") {
      if (row.length !== GRID) return null;
      for (let x = 0; x < GRID; x++) {
        const ch = row[x]!;
        if (ch === BLANK_CHAR) continue;
        const hue = ROW_CHARS.indexOf(ch);
        if (hue < 0) return null;
        grid[y * GRID + x] = hue;
      }
      continue;
    }
    if (!Array.isArray(row) || row.length !== GRID) return null;
    for (let x = 0; x < GRID; x++) {
      const cell = row[x];
      if (cell === null || cell === undefined || cell === -1) continue;
      const hue = intIn(cell, 0, HUES.length - 1);
      if (hue === null) return null;
      grid[y * GRID + x] = hue;
    }
  }
  return grid;
}

/** The inverse, for anything that wants to hand a grid back as rows. */
export function gridRows(grid: Grid): string[] {
  const rows: string[] = [];
  for (let y = 0; y < GRID; y++) {
    let row = "";
    for (let x = 0; x < GRID; x++) {
      const v = grid[y * GRID + x]!;
      row += v === EMPTY ? BLANK_CHAR : ROW_CHARS[v]!;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Round-trips the grid through the parser rather than trusting the body, so a
 * malformed blob is rejected here and never reaches the validator or the
 * database.
 */
export function parseSubmit(body: unknown): Parsed<ParsedSubmit> {
  if (!isRecord(body)) return bad("Send a JSON object with a grid field.");
  const grid = parseGrid(body.grid);
  if (!grid) {
    return bad(
      "That grid is not a grid. Send 64 rows of 64 characters (a-h, '.' for blank), " +
        "64 rows of 64 integers (0-7, -1 for blank), or the run-length string.",
      "bad_grid",
    );
  }

  const meter = parseMeter(body.meter);
  if (!meter.ok) return meter;

  return { ok: true, value: { grid, meter: meter.value } };
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
 * Serial wall clock to clear the whole puzzle space at this run's effective
 * pace. It is a projection of one agent working one board at a time, which is
 * the only projection the chained sequence permits — there is no parallel
 * version of this number, and the UI must not let anyone read it as throughput.
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
 * The rankings, and they answer different questions.
 *
 * They live here rather than in `server/bench.ts` because the server sorts the
 * response and the table re-sorts it when a reader toggles a column, and two
 * implementations of "which run is ahead" would eventually disagree about the
 * same rows on the same page.
 *
 * A run that has banked nothing sorts last under all of them, ahead of any
 * comparison of per-solve figures — dividing by zero solves produces a number,
 * and it is always a flattering one.
 */

/** Throughput. Sorts on effective time rather than the median, which is
 *  shoppable by abandoning hard boards. */
export function byEffectiveTime(a: BenchRow, b: BenchRow): number {
  if (a.solved === 0 || b.solved === 0) return b.solved - a.solved;
  return (
    a.effective_ms_per_solve - b.effective_ms_per_solve ||
    b.solved - a.solved ||
    a.first_at - b.first_at
  );
}

/**
 * The table's own ranking: progress first, pace as the tiebreak.
 *
 * The ladder is a fixed 500 distinct boards and every one of them is brutally
 * hard, so how far a run got is the fact worth leading with; wall clock only
 * ever decides between two runs that got equally far. This is also the
 * ordering used to pick a group's representative run — "most progress, tied
 * runs broken by pace" is one rule serving both jobs, so a model's row is
 * always some real run's numbers and never an invented average.
 *
 * A single implementation shared by `byProgress` (over `BenchRow`, for
 * choosing a representative) and `byGroupProgress` (over `BenchGroupRow`, for
 * the table itself) so the two cannot quietly diverge.
 */
function progressOrder(
  solvedA: number,
  solvedB: number,
  effA: number,
  effB: number,
  firstA: number,
  firstB: number,
): number {
  if (solvedA === 0 || solvedB === 0) return solvedB - solvedA;
  return solvedB - solvedA || effA - effB || firstA - firstB;
}

/** Ranks runs by ladder progress, pace as the tiebreak. Used to choose which
 *  run in a group best represents it. */
export function byProgress(a: BenchRow, b: BenchRow): number {
  return progressOrder(
    a.solved, b.solved,
    a.effective_ms_per_solve, b.effective_ms_per_solve,
    a.first_at, b.first_at,
  );
}

/** Same ordering, over the model-grouped row `/api/bench` actually serves. */
export function byGroupProgress(a: BenchGroupRow, b: BenchGroupRow): number {
  return progressOrder(
    a.solves, b.solves,
    a.effective_ms_per_solve, b.effective_ms_per_solve,
    a.first_at, b.first_at,
  );
}

/** Deduction. Looks at the board per solve, and capacity-independent: a busy
 *  endpoint changes how long an agent takes, never how many times it had to
 *  look before it knew the answer. */
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
  run: Pick<RunRow, "model" | "provider" | "config">,
): ChartPoint => ({
  run_id: row.run_id,
  model: run.model,
  provider: run.provider,
  config: run.config,
  idx: row.idx,
  difficulty: row.difficulty,
  points: row.points,
  wall_ms: row.wall_ms,
  bonds: row.bonds,
  api_calls: row.api_calls,
  probes: row.probes,
  tokens_in: row.tokens_in,
  tokens_out: row.tokens_out,
  cost_micro: row.cost_micro,
  created_at: row.created_at,
});

/** Guards a cell index before it is rendered or reasoned over. */
export const isCellIndex = (v: unknown): v is number => intIn(v, 0, CELLS - 1) !== null;
