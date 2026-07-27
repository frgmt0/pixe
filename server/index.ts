import { file } from "bun";
import { join } from "node:path";
import { decodeGrid, encodeGrid } from "../shared/codec";
import { generatePuzzle, isValidKey } from "../shared/generate";
import { assess } from "../shared/validate";
import {
  clearAttempts,
  clearCookie,
  currentUser,
  endSession,
  hashPassword,
  noteAttempt,
  sessionCookie,
  startSession,
  throttled,
  tokenFrom,
  validateCredentials,
  verifyPassword,
} from "./auth";
import { q, startSessionReaper, type UserRow } from "./db";

const PORT = Number(process.env.PORT ?? 3001);
const PROD = process.env.NODE_ENV === "production";
const DIST = join(import.meta.dir, "..", "dist");
const MAX_BODY = 64 * 1024;

startSessionReaper();

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

const fail = (status: number, error: string) => json({ error }, { status });

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY) return null;
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function shareId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
}

const publicUser = (u: UserRow) => ({ id: u.id, name: u.name });

function stateFor(u: UserRow) {
  const stats = q.userStats.get(u.id) ?? { score: 0, solved: 0, bonds: 0 };
  const solves = q.solvedKeys.all(u.id).map((r) => ({ key: r.puzzle_key, points: r.points }));
  return { user: publicUser(u), stats, solves };
}

function clientIp(req: Request, server: { requestIP(r: Request): { address: string } | null }): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    server.requestIP(req)?.address ||
    "unknown"
  );
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

async function api(req: Request, url: URL, server: Parameters<typeof clientIp>[1]): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  /* --- auth ------------------------------------------------------- */

  if (path === "/api/signup" || path === "/api/login") {
    if (method !== "POST") return fail(405, "Method not allowed");
    const ip = clientIp(req, server);
    if (throttled(ip)) return fail(429, "Too many attempts. Take a breather and try again shortly.");

    const body = await readJson(req);
    if (!body) return fail(400, "Bad request");
    const { name, password } = body;

    const invalid = validateCredentials(name, password);
    if (invalid) return fail(400, invalid);
    const nameStr = name as string;
    const passStr = password as string;

    if (path === "/api/signup") {
      if (q.userByName.get(nameStr.toLowerCase())) {
        return fail(409, "That name is taken. Try adding a number, everyone else does.");
      }
      noteAttempt(ip);
      const hash = await hashPassword(passStr);
      const row = q.createUser.get(nameStr, nameStr.toLowerCase(), hash, Date.now());
      if (!row) return fail(500, "Could not create that account.");
      clearAttempts(ip);
      const user = q.userById.get(row.id)!;
      return json(stateFor(user), { headers: { "set-cookie": sessionCookie(startSession(user.id)) } });
    }

    noteAttempt(ip);
    const user = q.userByName.get(nameStr.toLowerCase());
    // Always run a verify so a missing account and a wrong password take a
    // similar amount of time.
    const okPass = await verifyPassword(
      passStr,
      user?.pass ?? "$argon2id$v=19$m=65536,t=2,p=1$aaaaaaaaaaaaaaaa$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    if (!user || !okPass) return fail(401, "Wrong name or password.");
    clearAttempts(ip);
    return json(stateFor(user), { headers: { "set-cookie": sessionCookie(startSession(user.id)) } });
  }

  if (path === "/api/logout") {
    if (method !== "POST") return fail(405, "Method not allowed");
    endSession(tokenFrom(req));
    return json({ ok: true }, { headers: { "set-cookie": clearCookie() } });
  }

  if (path === "/api/me") {
    const user = currentUser(req);
    return user ? json(stateFor(user)) : json({ user: null });
  }

  /* --- public reads ----------------------------------------------- */

  if (path === "/api/leaderboard") {
    return json({ rows: q.leaderboard.all(100) });
  }

  if (path === "/api/gallery") {
    const rows = q.recentArt.all(24).map((r) => ({
      shareId: r.share_id,
      key: r.puzzle_key,
      name: r.name,
      bonds: r.bonds,
      points: r.points,
      art: r.art,
      at: r.created_at,
    }));
    return json({ rows });
  }

  const art = path.match(/^\/api\/art\/([A-Za-z0-9]{1,32})$/);
  if (art) {
    const row = q.artByShare.get(art[1]!);
    if (!row) return fail(404, "No such artwork.");
    const puzzle = generatePuzzle(row.puzzle_key);
    return json({
      shareId: row.share_id,
      key: row.puzzle_key,
      title: puzzle.title,
      // Safe to reveal: this puzzle is already solved by this player, and the
      // reveal is the whole point of the share page.
      rules: puzzle.rules,
      scheme: puzzle.scheme,
      bondPairs: puzzle.bonds,
      parBonds: puzzle.parBonds,
      name: row.name,
      points: row.points,
      bonds: row.bonds,
      art: row.art,
      at: row.created_at,
    });
  }

  /* --- authenticated puzzle state --------------------------------- */

  const prog = path.match(/^\/api\/progress\/([A-Za-z0-9-]{1,24})$/);
  if (prog) {
    const user = currentUser(req);
    if (!user) return fail(401, "Sign in first.");
    const key = prog[1]!;
    if (!isValidKey(key)) return fail(400, "Unknown puzzle.");

    if (method === "GET") {
      return json({ art: q.getProgress.get(user.id, key)?.art ?? null });
    }
    if (method === "PUT") {
      const body = await readJson(req);
      if (!body) return fail(400, "Bad request");
      // Round-trip through the decoder so we never persist a malformed blob.
      const grid = decodeGrid(body.art);
      if (!grid) return fail(400, "That canvas is not a canvas.");
      q.putProgress.run(user.id, key, encodeGrid(grid), Date.now());
      return json({ ok: true });
    }
    return fail(405, "Method not allowed");
  }

  const solve = path.match(/^\/api\/solve\/([A-Za-z0-9-]{1,24})$/);
  if (solve) {
    if (method !== "POST") return fail(405, "Method not allowed");
    const user = currentUser(req);
    if (!user) return fail(401, "Sign in first.");
    const key = solve[1]!;
    if (!isValidKey(key)) return fail(400, "Unknown puzzle.");

    const body = await readJson(req);
    if (!body) return fail(400, "Bad request");
    const grid = decodeGrid(body.art);
    if (!grid) return fail(400, "That canvas is not a canvas.");

    // The only thing the client is trusted with is the pixels. Rules, point
    // value and bond count are all re-derived here from the seed.
    const result = assess(key, grid);
    if (!result.solved) {
      return fail(422, "That grid does not satisfy every law yet. Nice try though.");
    }

    const existing = q.solve.get(user.id, key);
    if (existing) {
      return json({
        alreadySolved: true,
        points: 0,
        bonds: result.bonds,
        shareId: existing.share_id,
        ...stateFor(user),
      });
    }

    const row = q.insertSolve.get(
      user.id,
      key,
      result.puzzle.points,
      result.bonds,
      encodeGrid(grid),
      shareId(),
      Date.now(),
    )!;

    return json({
      alreadySolved: false,
      points: row.points,
      bonds: row.bonds,
      parBonds: result.puzzle.parBonds,
      shareId: row.share_id,
      ...stateFor(user),
    });
  }

  return fail(404, "No such endpoint.");
}

/* ------------------------------------------------------------------ */
/* Static assets + SPA fallback                                        */
/* ------------------------------------------------------------------ */

async function serveStatic(url: URL): Promise<Response> {
  if (!PROD) {
    return new Response("Run `bun run dev` — Vite serves the client on :5173 in development.", {
      status: 404,
    });
  }
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (rel && !rel.includes("..")) {
    const f = file(join(DIST, rel));
    if (await f.exists()) {
      const immutable = rel.startsWith("assets/");
      return new Response(f, {
        headers: immutable ? { "cache-control": "public, max-age=31536000, immutable" } : {},
      });
    }
  }
  // Everything else is a client route.
  return new Response(file(join(DIST, "index.html")), {
    headers: { "content-type": "text/html", "cache-control": "no-cache" },
  });
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 30,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(req, url, server);
      } catch (err) {
        console.error("api error", url.pathname, err);
        return fail(500, "Something broke on our end.");
      }
    }
    return serveStatic(url);
  },
});

console.log(`pixe api listening on http://localhost:${server.port}${PROD ? " (serving dist/)" : ""}`);
