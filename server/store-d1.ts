import {
  ISSUE_TTL_MS, SQL,
  type ArtRow, type ChartPoint, type IssueRow, type IssueSpan, type NewRunSolve,
  type RunRow, type RunSolveRow, type Store,
} from "./store";

/**
 * The slice of D1 this app actually touches.
 *
 * Declared structurally rather than pulling in `@cloudflare/workers-types`,
 * whose globals collide with the DOM and Bun lib types the rest of the project
 * compiles against. Four methods is a small enough surface that describing it
 * here is cheaper than maintaining a second tsconfig to isolate the conflict.
 */
export interface D1 {
  prepare(sql: string): D1Stmt;
}
export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

/**
 * D1 backend. The schema is *not* created here — D1 migrations run once at
 * deploy time via `wrangler d1 execute`, and issuing DDL on every cold start
 * would spend request latency re-proving something already true.
 */
export function d1Store(db: D1): Store {
  const get = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args).first<T>();
  const all = async <T>(sql: string, ...args: unknown[]) =>
    (await db.prepare(sql).bind(...args).all<T>()).results;
  const run = async (sql: string, ...args: unknown[]) => {
    await db.prepare(sql).bind(...args).run();
  };

  return {
    createRun: async (r) =>
      (await get<RunRow>(
        SQL.createRun, r.id, r.secret, r.model, r.provider, r.config, r.dialect,
        r.created_at, r.last_at, r.status, r.verified,
      ))!,
    runById: (id) => get<RunRow>(SQL.runById, id),
    touchRun: (id, now) => run(SQL.touchRun, now, id),
    closeRun: (id, now, status) => run(SQL.closeRun, status, now, id),
    runs: (limit) => all<RunRow>(SQL.runs, limit),

    openIssue: (rid) => get<IssueRow>(SQL.openIssue, rid),
    issueAt: (rid, idx) => get<IssueRow>(SQL.issueAt, rid, idx),
    // No row back means a concurrent /next already opened this index, so the
    // row that is already there is the answer. See SQL.insertIssue.
    insertIssue: async (rid, idx, key, now) =>
      (await get<IssueRow>(SQL.insertIssue, rid, idx, key, now)) ??
      (await get<IssueRow>(SQL.issueAt, rid, idx))!,
    closeIssue: (rid, idx, now, outcome) => run(SQL.closeIssue, now, outcome, rid, idx),
    advancePhase: (rid, idx, phase, grids) => run(SQL.advancePhase, phase, grids, rid, idx),
    nextIdx: async (rid) => (await get<{ n: number }>(SQL.nextIdx, rid))?.n ?? 0,
    issueDurations: (rid) => all<IssueSpan>(SQL.issueDurations, rid),
    bumpCalls: (rid, idx) => run(SQL.bumpCalls, rid, idx),
    callCount: async (rid, idx) => (await get<{ n: number }>(SQL.callCount, rid, idx))?.n ?? 0,
    bumpProbes: (rid, idx) => run(SQL.bumpProbes, rid, idx),
    probeCount: async (rid, idx) => (await get<{ n: number }>(SQL.probeCount, rid, idx))?.n ?? 0,

    insertRunSolve: async (s: NewRunSolve) =>
      (await get<RunSolveRow>(
        SQL.insertRunSolve, s.run_id, s.idx, s.puzzle_key, s.points, s.bonds, s.difficulty,
        s.wall_ms, s.api_calls, s.probes, s.tokens_in, s.tokens_out, s.cost_micro,
        s.art, s.share_id, s.created_at,
      )) ?? (await get<RunSolveRow>(SQL.solveAt, s.run_id, s.idx))!,
    runSolves: (rid) => all<RunSolveRow>(SQL.runSolves, rid),
    solveAt: (rid, idx) => get<RunSolveRow>(SQL.solveAt, rid, idx),
    allSolvesForCharts: (limit) => all<ChartPoint>(SQL.allSolvesForCharts, limit),

    artByShare: (s) => get<ArtRow>(SQL.artByShare, s),
    recentArt: (limit) => all<ArtRow>(SQL.recentArt, limit),

    attemptCount: async (ip, now) => (await get<{ n: number }>(SQL.attemptCount, ip, now))?.n ?? 0,
    noteAttempt: (ip, now, win) => run(SQL.noteAttempt, ip, now + win, now, now, now + win),
    clearAttempts: (ip) => run(SQL.clearAttempts, ip),

    // Two plain statements rather than a `batch`. Reaping runs from the cron
    // handler, which nothing else calls and whose failures are silent — so it
    // is the last place to use a method no other query path exercises. These
    // are independent writes on an hourly maintenance job; batching them would
    // buy one round trip in exchange for an untested code path.
    reap: async (now) => {
      await run(SQL.reapAttempts, now);
      await run(SQL.reapIssues, now, now - ISSUE_TTL_MS);
    },
  };
}
