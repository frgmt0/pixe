/**
 * The storage contract, and the one schema both backends build from.
 *
 * pixe runs on two very different substrates: a Bun process with a local
 * SQLite file, and a Cloudflare Worker talking to D1. Every method here is
 * async even though `bun:sqlite` answers synchronously — D1 cannot be made
 * synchronous, and async is the only common denominator. Paying a resolved
 * promise locally is far cheaper than maintaining two copies of the routes.
 */

export interface UserRow {
  id: number;
  name: string;
  name_lower: string;
  pass: string;
  created_at: number;
}

export interface SolveRow {
  id: number;
  user_id: number;
  puzzle_key: string;
  points: number;
  bonds: number;
  art: string;
  share_id: string;
  created_at: number;
}

export type ArtRow = SolveRow & { name: string };

export interface Stats {
  score: number;
  solved: number;
  bonds: number;
}

export interface LeaderRow {
  name: string;
  score: number;
  solved: number;
  bonds: number;
  last_at: number;
}

export interface Store {
  userByName(nameLower: string): Promise<UserRow | null>;
  userById(id: number): Promise<UserRow | null>;
  createUser(name: string, nameLower: string, pass: string, now: number): Promise<UserRow | null>;

  createSession(token: string, userId: number, now: number, expiresAt: number): Promise<void>;
  sessionUser(token: string, now: number): Promise<UserRow | null>;
  dropSession(token: string): Promise<void>;

  solve(userId: number, key: string): Promise<SolveRow | null>;
  solvedKeys(userId: number): Promise<{ puzzle_key: string; points: number }[]>;
  insertSolve(
    userId: number, key: string, points: number, bonds: number,
    art: string, shareId: string, now: number,
  ): Promise<SolveRow>;
  userStats(userId: number): Promise<Stats>;
  leaderboard(limit: number): Promise<LeaderRow[]>;

  artByShare(shareId: string): Promise<ArtRow | null>;
  recentArt(limit: number): Promise<ArtRow[]>;

  getProgress(userId: number, key: string): Promise<string | null>;
  putProgress(userId: number, key: string, art: string, now: number): Promise<void>;

  /**
   * Login throttling lives in the database rather than in a `Map`, because on
   * Workers there is no single process to hold that map: requests land in
   * whichever isolate is warm, and isolates are discarded freely. An
   * in-memory counter there does not throttle, it merely appears to.
   */
  attemptCount(ip: string, now: number): Promise<number>;
  noteAttempt(ip: string, now: number, windowMs: number): Promise<void>;
  clearAttempts(ip: string): Promise<void>;

  /** Drop expired sessions and stale throttle records. */
  reap(now: number): Promise<void>;
}

/**
 * Schema as discrete statements: D1 wants them one at a time, and Bun is happy
 * to loop. Keeping a single list means the two backends cannot drift.
 */
export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    name_lower TEXT NOT NULL UNIQUE,
    pass       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,

  // One row per (player, puzzle) they have finished. The unique constraint is
  // what stops a puzzle being farmed for points more than once.
  `CREATE TABLE IF NOT EXISTS solves (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    puzzle_key TEXT NOT NULL,
    points     INTEGER NOT NULL,
    bonds      INTEGER NOT NULL,
    art        TEXT NOT NULL,
    share_id   TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, puzzle_key)
  )`,
  `CREATE INDEX IF NOT EXISTS solves_user ON solves(user_id)`,
  `CREATE INDEX IF NOT EXISTS solves_key ON solves(puzzle_key)`,

  // Autosaved work-in-progress canvases, so a refresh never costs you a grid.
  `CREATE TABLE IF NOT EXISTS progress (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    puzzle_key TEXT NOT NULL,
    art        TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, puzzle_key)
  )`,

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
  userByName: "SELECT * FROM users WHERE name_lower = ?",
  userById: "SELECT * FROM users WHERE id = ?",
  createUser:
    "INSERT INTO users (name, name_lower, pass, created_at) VALUES (?, ?, ?, ?) RETURNING *",

  createSession:
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  sessionUser:
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`,
  dropSession: "DELETE FROM sessions WHERE token = ?",
  reapSessions: "DELETE FROM sessions WHERE expires_at <= ?",

  solve: "SELECT * FROM solves WHERE user_id = ? AND puzzle_key = ?",
  solvedKeys: "SELECT puzzle_key, points FROM solves WHERE user_id = ?",
  // `DO NOTHING` rather than a plain insert, so banking a solve is safe to
  // repeat. Two things make that matter: the router checks `solve` and then
  // inserts without a transaction around the pair, so two submissions racing
  // each other would otherwise collide on UNIQUE(user_id, puzzle_key); and a
  // write that commits but fails to answer would then be un-retryable forever,
  // turning one dropped connection into a permanently lost solve.
  //
  // On conflict this returns no row, so both backends fall back to selecting
  // the row that is already there.
  insertSolve:
    `INSERT INTO solves (user_id, puzzle_key, points, bonds, art, share_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, puzzle_key) DO NOTHING
     RETURNING *`,
  userStats:
    `SELECT COALESCE(SUM(points), 0) AS score,
            COUNT(*)                 AS solved,
            COALESCE(SUM(bonds), 0)  AS bonds
     FROM solves WHERE user_id = ?`,

  leaderboard:
    `SELECT u.name                        AS name,
            COALESCE(SUM(s.points), 0)    AS score,
            COUNT(s.id)                   AS solved,
            COALESCE(SUM(s.bonds), 0)     AS bonds,
            COALESCE(MAX(s.created_at), 0) AS last_at
     FROM users u LEFT JOIN solves s ON s.user_id = u.id
     GROUP BY u.id
     HAVING solved > 0
     ORDER BY score DESC, solved DESC, bonds DESC, last_at ASC
     LIMIT ?`,

  artByShare:
    "SELECT s.*, u.name FROM solves s JOIN users u ON u.id = s.user_id WHERE s.share_id = ?",
  recentArt:
    `SELECT s.*, u.name FROM solves s JOIN users u ON u.id = s.user_id
     ORDER BY s.created_at DESC LIMIT ?`,

  getProgress: "SELECT art FROM progress WHERE user_id = ? AND puzzle_key = ?",
  putProgress:
    `INSERT INTO progress (user_id, puzzle_key, art, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, puzzle_key)
     DO UPDATE SET art = excluded.art, updated_at = excluded.updated_at`,

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
};
