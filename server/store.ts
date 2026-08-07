/**
 * The storage contract, and the one schema both backends build from.
 *
 * pixe runs on two very different substrates: a Bun process with a local
 * SQLite file, and a Cloudflare Worker talking to D1. Every method here is
 * async even though `bun:sqlite` answers synchronously — D1 cannot be made
 * synchronous, and async is the only common denominator. Paying a resolved
 * promise locally is far cheaper than maintaining two copies of the routes.
 *
 * Row shapes live in `shared/protocol.ts` and are re-exported below; only the
 * rows with no wire representation at all — operators, pairing codes, issue
 * timing — are declared here.
 */
import type {
  ArtRow, ChartPoint, IssueRow, NewRunSolve, RunRow, RunSolveRow,
} from "../shared/protocol";

/**
 * A human who has vouched for at least one run.
 *
 * The benchmark showcases *harnesses*, and the harness is the one claim the
 * person at the keyboard both knows for certain and wants stated correctly —
 * unlike a model string, which is the claim someone would be tempted to fudge.
 * So it is collected from a human through a device-code flow rather than
 * self-declared by the agent.
 *
 * `key_hash` is the reusable credential handed back after the first pairing.
 * Storing only its hash means a database read cannot mint runs under someone
 * else's harness.
 */
export interface OperatorRow {
  id: string;
  key_hash: string;
  display: string;
  harness: string;
  /** Free prose about the setup — "Opus 5", "opus planner + haiku subagents". Never ranked. */
  config: string | null;
  contact: string | null;
  created_at: number;
  last_at: number;
}

/**
 * A pending device-code pairing. The agent shows `user_code` to its human, who
 * types it into /for-humans on whatever device they happen to be holding.
 *
 * Deliberately not a localhost callback: agents increasingly run in containers,
 * CI and cloud sandboxes where the human's browser is nowhere near the agent's
 * loopback interface. A short code the human carries to a hosted page is the
 * only shape that works in all of those, and it is the flow people already know
 * from signing a television into a streaming service.
 */
export interface PairCodeRow {
  user_code: string;
  run_id: string;
  created_at: number;
  expires_at: number;
  claimed_at: number | null;
  operator_id: string | null;
}

/**
 * The storage rows are defined once, in `shared/protocol.ts`, and re-exported
 * here.
 *
 * They were briefly declared in both places on the theory that a storage shape
 * and a wire shape are different concerns — `RunRow.secret` seeds the chained
 * sequence and must never reach a client. That reasoning was right about the
 * risk and wrong about the remedy: two copies of a wide row drift silently,
 * and the drift surfaces as a runtime mismatch rather than a type error. What
 * actually keeps `secret` out of a response is that responses are built from
 * explicit projections, never by spreading a row.
 */
export type { ArtRow, ChartPoint, IssueRow, NewRunSolve, RunRow, RunSolveRow };

/**
 * Issue timing, including the abandoned ones.
 *
 * `run_solves.wall_ms` only ever covers the board that was banked, so a run
 * that abandons everything hard and banks only what looks easy posts a better
 * per-solve time than one that grinds every board it is dealt. Projecting to
 * 1M puzzles off that number rewards shopping. Summing durations here — solved
 * and abandoned alike — is what makes the projection honest.
 */
export interface IssueSpan {
  idx: number;
  issued_at: number;
  closed_at: number | null;
  outcome: string | null;
}

export interface Store {
  createOperator(row: OperatorRow): Promise<OperatorRow>;
  operatorById(id: string): Promise<OperatorRow | null>;
  operatorByKeyHash(hash: string): Promise<OperatorRow | null>;
  touchOperator(id: string, now: number): Promise<void>;

  createPairCode(row: PairCodeRow): Promise<void>;
  pairCode(userCode: string): Promise<PairCodeRow | null>;
  claimPairCode(userCode: string, operatorId: string, now: number): Promise<void>;
  /**
   * Binds the run to its operator and lifts it out of `pending`.
   *
   * Copies the identity down onto the run rather than leaving it to a join:
   * every row that displays a run reads `runs`, and an operator who pairs a
   * second agent under a different setup must not retroactively relabel the
   * runs the first one already banked.
   */
  attachOperator(
    runId: string,
    operatorId: string,
    harness: string,
    config: string | null,
    now: number,
  ): Promise<void>;

  createRun(row: RunRow): Promise<RunRow>;
  runById(id: string): Promise<RunRow | null>;
  touchRun(id: string, now: number): Promise<void>;
  closeRun(id: string, now: number, status: RunRow["status"]): Promise<void>;
  runs(limit: number): Promise<RunRow[]>;

  openIssue(runId: string): Promise<IssueRow | null>;
  issueAt(runId: string, idx: number): Promise<IssueRow | null>;
  insertIssue(runId: string, idx: number, key: string, now: number): Promise<IssueRow>;
  closeIssue(runId: string, idx: number, now: number, outcome: string): Promise<void>;
  nextIdx(runId: string): Promise<number>;
  /** Every issue's timing, so the benchmark can charge for abandoned work. */
  issueDurations(runId: string): Promise<IssueSpan[]>;
  /** Bumped per request against an open issue, so `api_calls` is measured not claimed. */
  bumpCalls(runId: string, idx: number): Promise<void>;
  callCount(runId: string, idx: number): Promise<number>;
  /**
   * Probes are the capacity-independent half of the benchmark. Wall clock
   * conflates deduction with whatever the provider's endpoint was doing that
   * afternoon; how many times an agent had to look at the board before it knew
   * the answer does not.
   */
  bumpProbes(runId: string, idx: number): Promise<void>;
  probeCount(runId: string, idx: number): Promise<number>;

  insertRunSolve(row: NewRunSolve): Promise<RunSolveRow>;
  runSolves(runId: string): Promise<RunSolveRow[]>;
  solveAt(runId: string, idx: number): Promise<RunSolveRow | null>;
  /** Every solve, flattened with its run's identity, for `/api/bench`. */
  allSolvesForCharts(limit: number): Promise<ChartPoint[]>;

  artByShare(shareId: string): Promise<ArtRow | null>;
  recentArt(limit: number): Promise<ArtRow[]>;

  /**
   * Run-creation throttling lives in the database rather than in a `Map`,
   * because on Workers there is no single process to hold that map: requests
   * land in whichever isolate is warm, and isolates are discarded freely. An
   * in-memory counter there does not throttle, it merely appears to.
   */
  attemptCount(ip: string, now: number): Promise<number>;
  noteAttempt(ip: string, now: number, windowMs: number): Promise<void>;
  clearAttempts(ip: string): Promise<void>;

  /** Drop stale throttle records and abandon runs that walked away mid-puzzle. */
  reap(now: number): Promise<void>;
}

/**
 * Schema as discrete statements: D1 wants them one at a time, and Bun is happy
 * to loop. Keeping a single list means the two backends cannot drift.
 */
export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS operators (
    id         TEXT PRIMARY KEY,
    key_hash   TEXT NOT NULL UNIQUE,
    display    TEXT NOT NULL,
    harness    TEXT NOT NULL,
    config     TEXT,
    contact    TEXT,
    created_at INTEGER NOT NULL,
    last_at    INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS pair_codes (
    user_code   TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    claimed_at  INTEGER,
    operator_id TEXT REFERENCES operators(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS pair_codes_run ON pair_codes(run_id)`,

  // The harness is the benchmarked identity and it arrives from the human at
  // pairing, never from the agent. There is deliberately no `model` column: a
  // harness with subagents may drive several, so a single model string is
  // ill-defined rather than merely unverifiable, and a sortable column of them
  // would read as a model leaderboard this benchmark cannot honestly produce.
  // `config` is free prose about the setup and is never ranked or aggregated.
  `CREATE TABLE IF NOT EXISTS runs (
    id          TEXT PRIMARY KEY,
    secret      TEXT NOT NULL,
    harness     TEXT,
    config      TEXT,
    operator_id TEXT REFERENCES operators(id) ON DELETE SET NULL,
    dialect     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    last_at     INTEGER NOT NULL,
    status      TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS runs_created ON runs(created_at)`,
  `CREATE INDEX IF NOT EXISTS runs_operator ON runs(operator_id)`,

  `CREATE TABLE IF NOT EXISTS issues (
    run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    idx        INTEGER NOT NULL,
    puzzle_key TEXT NOT NULL,
    issued_at  INTEGER NOT NULL,
    closed_at  INTEGER,
    outcome    TEXT,
    api_calls  INTEGER NOT NULL DEFAULT 0,
    probes     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (run_id, idx)
  )`,

  // "One open puzzle per run" is the rule that makes batch solving impossible,
  // so it is enforced by the database rather than by a check in the router.
  // A partial unique index cannot be raced the way a SELECT-then-INSERT can.
  `CREATE UNIQUE INDEX IF NOT EXISTS issues_one_open
     ON issues(run_id) WHERE closed_at IS NULL`,

  `CREATE TABLE IF NOT EXISTS run_solves (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    idx        INTEGER NOT NULL,
    puzzle_key TEXT NOT NULL,
    points     INTEGER NOT NULL,
    bonds      INTEGER NOT NULL,
    difficulty INTEGER NOT NULL,
    wall_ms    INTEGER NOT NULL,
    api_calls  INTEGER NOT NULL,
    probes     INTEGER NOT NULL,
    events     INTEGER NOT NULL,
    tokens_in  INTEGER,
    tokens_out INTEGER,
    cost_micro INTEGER,
    art        TEXT NOT NULL,
    share_id   TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    UNIQUE (run_id, idx)
  )`,
  `CREATE INDEX IF NOT EXISTS run_solves_run ON run_solves(run_id)`,
  `CREATE INDEX IF NOT EXISTS run_solves_created ON run_solves(created_at)`,

  `CREATE TABLE IF NOT EXISTS attempts (
    ip    TEXT PRIMARY KEY,
    n     INTEGER NOT NULL,
    until INTEGER NOT NULL
  )`,
];

/* ------------------------------------------------------------------ */
/* SQL shared by both backends                                         */
/* ------------------------------------------------------------------ */

export const SQL = {
  createOperator:
    `INSERT INTO operators (id, key_hash, display, harness, config, contact, created_at, last_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  operatorById: "SELECT * FROM operators WHERE id = ?",
  operatorByKeyHash: "SELECT * FROM operators WHERE key_hash = ?",
  touchOperator: "UPDATE operators SET last_at = ? WHERE id = ?",

  createPairCode:
    `INSERT INTO pair_codes (user_code, run_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
  pairCode: "SELECT * FROM pair_codes WHERE user_code = ?",
  // Guarded on `claimed_at IS NULL` so two humans racing the same code cannot
  // both bind it — the second update matches no row rather than overwriting
  // the first one's operator.
  claimPairCode:
    `UPDATE pair_codes SET claimed_at = ?, operator_id = ?
     WHERE user_code = ? AND claimed_at IS NULL`,
  attachOperator:
    `UPDATE runs SET operator_id = ?, harness = ?, config = ?, status = 'open', last_at = ?
     WHERE id = ? AND operator_id IS NULL`,
  reapPairCodes: "DELETE FROM pair_codes WHERE expires_at <= ? AND claimed_at IS NULL",

  createRun:
    `INSERT INTO runs
       (id, secret, harness, config, operator_id, dialect, created_at, last_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  runById: "SELECT * FROM runs WHERE id = ?",
  touchRun: "UPDATE runs SET last_at = ? WHERE id = ?",
  closeRun: "UPDATE runs SET status = ?, last_at = ? WHERE id = ?",
  runs: "SELECT * FROM runs ORDER BY created_at DESC LIMIT ?",

  openIssue: "SELECT * FROM issues WHERE run_id = ? AND closed_at IS NULL",
  issueAt: "SELECT * FROM issues WHERE run_id = ? AND idx = ?",
  // DO NOTHING rather than a plain insert: two `/api/next` calls racing each
  // other must not produce two open puzzles, and the loser needs to be able to
  // read back the issue the winner created rather than see an error.
  insertIssue:
    `INSERT INTO issues (run_id, idx, puzzle_key, issued_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (run_id, idx) DO NOTHING
     RETURNING *`,
  closeIssue:
    `UPDATE issues SET closed_at = ?, outcome = ?
     WHERE run_id = ? AND idx = ? AND closed_at IS NULL`,
  nextIdx: "SELECT COALESCE(MAX(idx) + 1, 0) AS n FROM issues WHERE run_id = ?",
  issueDurations:
    "SELECT idx, issued_at, closed_at, outcome FROM issues WHERE run_id = ? ORDER BY idx",
  bumpCalls: "UPDATE issues SET api_calls = api_calls + 1 WHERE run_id = ? AND idx = ?",
  // A probe is a request that shows the agent how the board reacted: an attest
  // batch, or a submit that came back unsolved. Counted apart from `api_calls`
  // because that total also carries fetches which reveal nothing — asking for
  // the board again tells you only what you were already told.
  bumpProbes: "UPDATE issues SET probes = probes + 1 WHERE run_id = ? AND idx = ?",
  callCount: "SELECT api_calls AS n FROM issues WHERE run_id = ? AND idx = ?",
  probeCount: "SELECT probes AS n FROM issues WHERE run_id = ? AND idx = ?",

  // Banking a solve is idempotent. The router checks `solveAt` and then inserts
  // without a transaction around the pair, so concurrent submissions of the
  // same puzzle would otherwise collide on UNIQUE(run_id, idx); and a write
  // that commits but fails to answer would be un-retryable forever, turning one
  // dropped connection into a permanently lost solve. On conflict this returns
  // no row, so both backends fall back to selecting the row already there.
  insertRunSolve:
    `INSERT INTO run_solves
       (run_id, idx, puzzle_key, points, bonds, difficulty, wall_ms, api_calls,
        probes, events, tokens_in, tokens_out, cost_micro, art, share_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id, idx) DO NOTHING
     RETURNING *`,
  runSolves: "SELECT * FROM run_solves WHERE run_id = ? ORDER BY idx",
  solveAt: "SELECT * FROM run_solves WHERE run_id = ? AND idx = ?",

  allSolvesForCharts:
    `SELECT s.run_id, r.harness, r.config, s.idx, s.difficulty, s.points, s.wall_ms,
            s.bonds, s.api_calls, s.probes, s.events, s.tokens_in, s.tokens_out, s.cost_micro
     FROM run_solves s JOIN runs r ON r.id = s.run_id
     ORDER BY s.created_at DESC LIMIT ?`,

  // `r.dialect` rides along so the share page can reveal the laws this player
  // actually fought. It is server-side only — see the note on ArtRow.
  artByShare:
    `SELECT s.*, r.harness, r.config, r.dialect FROM run_solves s JOIN runs r ON r.id = s.run_id
     WHERE s.share_id = ?`,
  recentArt:
    `SELECT s.*, r.harness, r.config, r.dialect FROM run_solves s JOIN runs r ON r.id = s.run_id
     ORDER BY s.created_at DESC LIMIT ?`,

  attemptCount: "SELECT n FROM attempts WHERE ip = ? AND until > ?",
  // Written with repeated plain `?` rather than numbered parameters, because
  // the two drivers do not agree on `?NNN`. Bound as:
  //   ip, now + window, now, now, now + window
  noteAttempt:
    `INSERT INTO attempts (ip, n, until) VALUES (?, 1, ?)
     ON CONFLICT (ip) DO UPDATE SET
       n     = CASE WHEN until <= ? THEN 1 ELSE n + 1 END,
       until = CASE WHEN until <= ? THEN ? ELSE until END`,
  clearAttempts: "DELETE FROM attempts WHERE ip = ?",
  reapAttempts: "DELETE FROM attempts WHERE until <= ?",

  // An agent that stops mid-puzzle would otherwise hold its one open issue
  // forever and never be able to call /api/next again. Abandoning the issue
  // rather than deleting it keeps the chain's index sequence intact — the next
  // key still derives from the last *solved* puzzle, so nothing is skipped.
  reapIssues:
    `UPDATE issues SET closed_at = ?, outcome = 'abandoned'
     WHERE closed_at IS NULL AND issued_at <= ?`,

  // A run whose human never finished pairing is abandoned onboarding, not a
  // participant, and it holds a code that should not stay guessable forever.
  reapPendingRuns:
    "DELETE FROM runs WHERE status = 'pending' AND created_at <= ?",
};

/** How long a device code stays claimable before the human has to start over. */
export const PAIR_CODE_TTL_MS = 15 * 60 * 1000;

/** How long an issue may sit open before the sweep abandons it. */
export const ISSUE_TTL_MS = 6 * 60 * 60 * 1000;
