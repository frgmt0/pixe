import {
  SQL,
  type ArtRow, type LeaderRow, type SolveRow, type Stats, type Store, type UserRow,
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
    userByName: (n) => get<UserRow>(SQL.userByName, n),
    userById: (id) => get<UserRow>(SQL.userById, id),
    createUser: (name, lower, pass, now) => get<UserRow>(SQL.createUser, name, lower, pass, now),

    createSession: (t, u, now, exp) => run(SQL.createSession, t, u, now, exp),
    sessionUser: (t, now) => get<UserRow>(SQL.sessionUser, t, now),
    dropSession: (t) => run(SQL.dropSession, t),

    solve: (u, k) => get<SolveRow>(SQL.solve, u, k),
    solvedKeys: (u) => all(SQL.solvedKeys, u),
    // No row back means this player had already banked this puzzle, so the
    // existing row is the answer. See the note on SQL.insertSolve.
    insertSolve: async (u, k, p, b, art, share, now) =>
      (await get<SolveRow>(SQL.insertSolve, u, k, p, b, art, share, now)) ??
      (await get<SolveRow>(SQL.solve, u, k))!,
    userStats: async (u) =>
      (await get<Stats>(SQL.userStats, u)) ?? { score: 0, solved: 0, bonds: 0 },
    leaderboard: (limit) => all<LeaderRow>(SQL.leaderboard, limit),

    artByShare: (s) => get<ArtRow>(SQL.artByShare, s),
    recentArt: (limit) => all<ArtRow>(SQL.recentArt, limit),

    getProgress: async (u, k) => (await get<{ art: string }>(SQL.getProgress, u, k))?.art ?? null,
    putProgress: (u, k, art, now) => run(SQL.putProgress, u, k, art, now),

    attemptCount: async (ip, now) => (await get<{ n: number }>(SQL.attemptCount, ip, now))?.n ?? 0,
    noteAttempt: (ip, now, win) => run(SQL.noteAttempt, ip, now + win, now, now, now + win),
    clearAttempts: (ip) => run(SQL.clearAttempts, ip),

    // Two plain statements rather than a `batch`. Reaping runs from the cron
    // handler, which nothing else calls and whose failures are silent — so it
    // is the last place to use a method no other query path exercises. These
    // are independent deletes on an hourly maintenance job; batching them
    // would buy one round trip in exchange for an untested code path.
    reap: async (now) => {
      await run(SQL.reapSessions, now);
      await run(SQL.reapAttempts, now);
    },
  };
}
