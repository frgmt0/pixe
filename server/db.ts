import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.PIXE_DB ?? "./data/pixe.sqlite";

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true });

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    name_lower TEXT NOT NULL UNIQUE,
    pass       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

  -- One row per (player, puzzle) they have finished. The unique constraint is
  -- what stops a puzzle being farmed for points more than once.
  CREATE TABLE IF NOT EXISTS solves (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    puzzle_key TEXT NOT NULL,
    points     INTEGER NOT NULL,
    bonds      INTEGER NOT NULL,
    art        TEXT NOT NULL,
    share_id   TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, puzzle_key)
  );
  CREATE INDEX IF NOT EXISTS solves_user ON solves(user_id);
  CREATE INDEX IF NOT EXISTS solves_key ON solves(puzzle_key);

  -- Autosaved work-in-progress canvases, so a refresh never costs you a grid.
  CREATE TABLE IF NOT EXISTS progress (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    puzzle_key TEXT NOT NULL,
    art        TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, puzzle_key)
  );
`);

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

export const q = {
  userByName: db.query<UserRow, [string]>("SELECT * FROM users WHERE name_lower = ?"),
  userById: db.query<UserRow, [number]>("SELECT * FROM users WHERE id = ?"),
  createUser: db.query<{ id: number }, [string, string, string, number]>(
    "INSERT INTO users (name, name_lower, pass, created_at) VALUES (?, ?, ?, ?) RETURNING id",
  ),

  createSession: db.query<void, [string, number, number, number]>(
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  ),
  sessionUser: db.query<UserRow, [string, number]>(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`,
  ),
  dropSession: db.query<void, [string]>("DELETE FROM sessions WHERE token = ?"),
  reapSessions: db.query<void, [number]>("DELETE FROM sessions WHERE expires_at <= ?"),

  solve: db.query<SolveRow, [number, string]>(
    "SELECT * FROM solves WHERE user_id = ? AND puzzle_key = ?",
  ),
  solvedKeys: db.query<{ puzzle_key: string; points: number }, [number]>(
    "SELECT puzzle_key, points FROM solves WHERE user_id = ?",
  ),
  insertSolve: db.query<SolveRow, [number, string, number, number, string, string, number]>(
    `INSERT INTO solves (user_id, puzzle_key, points, bonds, art, share_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ),
  userStats: db.query<{ score: number; solved: number; bonds: number }, [number]>(
    `SELECT COALESCE(SUM(points), 0) AS score,
            COUNT(*)                 AS solved,
            COALESCE(SUM(bonds), 0)  AS bonds
     FROM solves WHERE user_id = ?`,
  ),

  leaderboard: db.query<
    { name: string; score: number; solved: number; bonds: number; last_at: number },
    [number]
  >(
    `SELECT u.name                    AS name,
            COALESCE(SUM(s.points),0) AS score,
            COUNT(s.id)               AS solved,
            COALESCE(SUM(s.bonds),0)  AS bonds,
            COALESCE(MAX(s.created_at),0) AS last_at
     FROM users u LEFT JOIN solves s ON s.user_id = u.id
     GROUP BY u.id
     HAVING solved > 0
     ORDER BY score DESC, solved DESC, bonds DESC, last_at ASC
     LIMIT ?`,
  ),

  artByShare: db.query<SolveRow & { name: string }, [string]>(
    "SELECT s.*, u.name FROM solves s JOIN users u ON u.id = s.user_id WHERE s.share_id = ?",
  ),
  recentArt: db.query<SolveRow & { name: string }, [number]>(
    `SELECT s.*, u.name FROM solves s JOIN users u ON u.id = s.user_id
     ORDER BY s.created_at DESC LIMIT ?`,
  ),

  getProgress: db.query<{ art: string }, [number, string]>(
    "SELECT art FROM progress WHERE user_id = ? AND puzzle_key = ?",
  ),
  putProgress: db.query<void, [number, string, string, number]>(
    `INSERT INTO progress (user_id, puzzle_key, art, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, puzzle_key) DO UPDATE SET art = excluded.art, updated_at = excluded.updated_at`,
  ),
};

/** Drop expired sessions on boot and hourly thereafter. */
export function startSessionReaper(): void {
  const sweep = () => q.reapSessions.run(Date.now());
  sweep();
  setInterval(sweep, 60 * 60 * 1000).unref?.();
}
