import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  SCHEMA, SQL,
  type ArtRow, type LeaderRow, type SolveRow, type Stats, type Store, type UserRow,
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
    userByName: (n) => get<UserRow>(SQL.userByName, n),
    userById: (id) => get<UserRow>(SQL.userById, id),
    createUser: (name, lower, pass, now) => get<UserRow>(SQL.createUser, name, lower, pass, now),

    createSession: (t, u, now, exp) => run(SQL.createSession, t, u, now, exp),
    sessionUser: (t, now) => get<UserRow>(SQL.sessionUser, t, now),
    dropSession: (t) => run(SQL.dropSession, t),

    solve: (u, k) => get<SolveRow>(SQL.solve, u, k),
    solvedKeys: (u) => all(SQL.solvedKeys, u),
    insertSolve: async (u, k, p, b, art, share, now) =>
      (await get<SolveRow>(SQL.insertSolve, u, k, p, b, art, share, now))!,
    userStats: async (u) =>
      (await get<Stats>(SQL.userStats, u)) ?? { score: 0, solved: 0, bonds: 0 },
    leaderboard: (limit) => all<LeaderRow>(SQL.leaderboard, limit),

    artByShare: (s) => get<ArtRow>(SQL.artByShare, s),
    recentArt: (limit) => all<ArtRow>(SQL.recentArt, limit),

    getProgress: async (u, k) => (await get<{ art: string }>(SQL.getProgress, u, k))?.art ?? null,
    putProgress: (u, k, art, now) => run(SQL.putProgress, u, k, art, now),

    attemptCount: async (ip, now) =>
      (await get<{ n: number }>(SQL.attemptCount, ip, now))?.n ?? 0,
    noteAttempt: (ip, now, win) =>
      run(SQL.noteAttempt, ip, now + win, now, now, now + win),
    clearAttempts: (ip) => run(SQL.clearAttempts, ip),

    reap: async (now) => {
      await run(SQL.reapSessions, now);
      await run(SQL.reapAttempts, now);
    },
  };
}
