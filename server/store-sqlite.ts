import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  ISSUE_TTL_MS, PAIR_CODE_TTL_MS, SCHEMA, SQL,
  type ArtRow, type ChartPoint, type IssueRow, type IssueSpan, type NewRunSolve,
  type OperatorRow, type PairCodeRow, type RunRow, type RunSolveRow, type Store,
} from "./store";

/**
 * `bun:sqlite` backend, used by the local dev server and `bun run start`.
 *
 * Every method returns a promise it has already resolved. That is not waste
 * dressed up as abstraction: it is what lets the router be written once and
 * run unchanged on Workers, where the same calls really are asynchronous.
 */
export function sqliteStore(path = process.env.PIXE_DB ?? "./data/pixe.sqlite"): Store {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  for (const stmt of SCHEMA) db.exec(stmt);

  const get = <T>(sql: string, ...args: unknown[]) =>
    Promise.resolve((db.query(sql).get(...(args as never[])) as T | null) ?? null);
  const all = <T>(sql: string, ...args: unknown[]) =>
    Promise.resolve(db.query(sql).all(...(args as never[])) as T[]);
  const run = (sql: string, ...args: unknown[]) => {
    db.query(sql).run(...(args as never[]));
    return Promise.resolve();
  };

  return {
    createOperator: async (o) =>
      (await get<OperatorRow>(
        SQL.createOperator, o.id, o.key_hash, o.display, o.harness, o.config, o.contact,
        o.created_at, o.last_at,
      ))!,
    operatorById: (id) => get<OperatorRow>(SQL.operatorById, id),
    operatorByKeyHash: (h) => get<OperatorRow>(SQL.operatorByKeyHash, h),
    touchOperator: (id, now) => run(SQL.touchOperator, now, id),

    createPairCode: (p) =>
      run(SQL.createPairCode, p.user_code, p.run_id, p.created_at, p.expires_at),
    pairCode: (code) => get<PairCodeRow>(SQL.pairCode, code),
    claimPairCode: (code, op, now) => run(SQL.claimPairCode, now, op, code),
    attachOperator: (runId, op, harness, config, now) =>
      run(SQL.attachOperator, op, harness, config, now, runId),

    createRun: async (r) =>
      (await get<RunRow>(
        SQL.createRun, r.id, r.secret, r.harness, r.config, r.operator_id, r.dialect,
        r.created_at, r.last_at, r.status,
      ))!,
    runById: (id) => get<RunRow>(SQL.runById, id),
    touchRun: (id, now) => run(SQL.touchRun, now, id),
    closeRun: (id, now, status) => run(SQL.closeRun, status, now, id),
    runs: (limit) => all<RunRow>(SQL.runs, limit),

    openIssue: (rid) => get<IssueRow>(SQL.openIssue, rid),
    issueAt: (rid, idx) => get<IssueRow>(SQL.issueAt, rid, idx),
    // No row back means a concurrent /api/next already opened this index, so
    // the row that is already there is the answer. See SQL.insertIssue.
    insertIssue: async (rid, idx, key, now) =>
      (await get<IssueRow>(SQL.insertIssue, rid, idx, key, now)) ??
      (await get<IssueRow>(SQL.issueAt, rid, idx))!,
    closeIssue: (rid, idx, now, outcome) => run(SQL.closeIssue, now, outcome, rid, idx),
    nextIdx: async (rid) => (await get<{ n: number }>(SQL.nextIdx, rid))?.n ?? 0,
    issueDurations: (rid) => all<IssueSpan>(SQL.issueDurations, rid),
    bumpCalls: (rid, idx) => run(SQL.bumpCalls, rid, idx),
    callCount: async (rid, idx) => (await get<{ n: number }>(SQL.callCount, rid, idx))?.n ?? 0,
    bumpProbes: (rid, idx) => run(SQL.bumpProbes, rid, idx),
    probeCount: async (rid, idx) => (await get<{ n: number }>(SQL.probeCount, rid, idx))?.n ?? 0,

    insertRunSolve: async (s: NewRunSolve) =>
      (await get<RunSolveRow>(
        SQL.insertRunSolve, s.run_id, s.idx, s.puzzle_key, s.points, s.bonds, s.difficulty,
        s.wall_ms, s.api_calls, s.probes, s.events, s.tokens_in, s.tokens_out, s.cost_micro,
        s.art, s.share_id, s.created_at,
      )) ?? (await get<RunSolveRow>(SQL.solveAt, s.run_id, s.idx))!,
    runSolves: (rid) => all<RunSolveRow>(SQL.runSolves, rid),
    solveAt: (rid, idx) => get<RunSolveRow>(SQL.solveAt, rid, idx),
    allSolvesForCharts: (limit) => all<ChartPoint>(SQL.allSolvesForCharts, limit),

    artByShare: (s) => get<ArtRow>(SQL.artByShare, s),
    recentArt: (limit) => all<ArtRow>(SQL.recentArt, limit),

    attemptCount: async (ip, now) =>
      (await get<{ n: number }>(SQL.attemptCount, ip, now))?.n ?? 0,
    noteAttempt: (ip, now, win) =>
      run(SQL.noteAttempt, ip, now + win, now, now, now + win),
    clearAttempts: (ip) => run(SQL.clearAttempts, ip),

    reap: async (now) => {
      await run(SQL.reapAttempts, now);
      await run(SQL.reapIssues, now, now - ISSUE_TTL_MS);
      await run(SQL.reapPairCodes, now);
      await run(SQL.reapPendingRuns, now - PAIR_CODE_TTL_MS);
    },
  };
}
