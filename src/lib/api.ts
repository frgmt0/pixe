import type { Bond, Rule } from "@shared/rules";
import type { ZoneScheme } from "@shared/zones";

export interface PublicUser {
  id: number;
  name: string;
}

export interface Stats {
  score: number;
  solved: number;
  bonds: number;
}

export interface SolveSummary {
  key: string;
  points: number;
}

export interface AuthState {
  user: PublicUser | null;
  stats?: Stats;
  solves?: SolveSummary[];
}

export interface LeaderRow {
  name: string;
  score: number;
  solved: number;
  bonds: number;
  last_at: number;
}

export interface ArtPost {
  shareId: string;
  key: string;
  title: string;
  rules: Rule[];
  scheme: ZoneScheme;
  bondPairs: Bond[];
  parBonds: number;
  name: string;
  points: number;
  bonds: number;
  art: string;
  at: number;
}

export interface SolveResult {
  alreadySolved: boolean;
  points: number;
  bonds: number;
  parBonds?: number;
  shareId: string;
  user: PublicUser;
  stats: Stats;
  solves: SolveSummary[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "same-origin",
      headers: init?.body ? { "content-type": "application/json" } : undefined,
      ...init,
    });
  } catch {
    throw new ApiError("Can't reach the server. Is it awake?", 0);
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) throw new ApiError(String(data.error ?? "Something went wrong."), res.status);
  return data as T;
}

const post = (path: string, body?: unknown) =>
  call<never>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  me: () => call<AuthState>("/api/me"),
  signup: (name: string, password: string) =>
    call<AuthState>("/api/signup", { method: "POST", body: JSON.stringify({ name, password }) }),
  login: (name: string, password: string) =>
    call<AuthState>("/api/login", { method: "POST", body: JSON.stringify({ name, password }) }),
  logout: () => post("/api/logout"),

  leaderboard: () => call<{ rows: LeaderRow[] }>("/api/leaderboard"),
  gallery: () =>
    call<{ rows: { shareId: string; key: string; name: string; bonds: number; points: number; art: string; at: number }[] }>(
      "/api/gallery",
    ),
  art: (shareId: string) => call<ArtPost>(`/api/art/${shareId}`),

  progress: (key: string) => call<{ art: string | null }>(`/api/progress/${key}`),
  saveProgress: (key: string, art: string) =>
    call<{ ok: true }>(`/api/progress/${key}`, { method: "PUT", body: JSON.stringify({ art }) }),

  solve: (key: string, art: string) =>
    call<SolveResult>(`/api/solve/${key}`, { method: "POST", body: JSON.stringify({ art }) }),
};
