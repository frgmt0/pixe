import { decodeGrid, encodeGrid } from "../shared/codec";
import { generatePuzzle, isValidKey } from "../shared/generate";
import { assess } from "../shared/validate";
import {
  DUMMY_HASH,
  THROTTLE_WINDOW_MS,
  clearCookie,
  currentUser,
  endSession,
  hashPassword,
  sessionCookie,
  startSession,
  throttled,
  tokenFrom,
  validateCredentials,
  verifyPassword,
} from "./auth";
import type { Store, UserRow } from "./store";

const MAX_BODY = 64 * 1024;

/**
 * Everything a request needs that differs between runtimes. The routes below
 * are otherwise identical on Bun and on Workers, which is the entire point of
 * threading these three values through rather than importing them.
 */
export interface Deps {
  store: Store;
  /** Client address, for throttling. */
  ip: string;
  /** Whether to mark cookies `Secure` — false only on plain-HTTP localhost. */
  secure: boolean;
}

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
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
}

const publicUser = (u: UserRow) => ({ id: u.id, name: u.name });

async function stateFor(store: Store, u: UserRow) {
  const [stats, rows] = await Promise.all([store.userStats(u.id), store.solvedKeys(u.id)]);
  return {
    user: publicUser(u),
    stats,
    solves: rows.map((r) => ({ key: r.puzzle_key, points: r.points })),
  };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export async function handleApi(req: Request, url: URL, deps: Deps): Promise<Response> {
  const { store, ip, secure } = deps;
  const path = url.pathname;
  const method = req.method;

  /* --- auth ------------------------------------------------------- */

  if (path === "/api/signup" || path === "/api/login") {
    if (method !== "POST") return fail(405, "Method not allowed");
    if (await throttled(store, ip)) {
      return fail(429, "Too many attempts. Take a breather and try again shortly.");
    }

    const body = await readJson(req);
    if (!body) return fail(400, "Bad request");
    const { name, password } = body;

    const invalid = validateCredentials(name, password);
    if (invalid) return fail(400, invalid);
    const nameStr = name as string;
    const passStr = password as string;

    if (path === "/api/signup") {
      if (await store.userByName(nameStr.toLowerCase())) {
        return fail(409, "That name is taken. Try adding a number, everyone else does.");
      }
      await store.noteAttempt(ip, Date.now(), THROTTLE_WINDOW_MS);
      const hash = await hashPassword(passStr);
      const user = await store.createUser(nameStr, nameStr.toLowerCase(), hash, Date.now());
      if (!user) return fail(500, "Could not create that account.");
      await store.clearAttempts(ip);
      const token = await startSession(store, user.id);
      return json(await stateFor(store, user), {
        headers: { "set-cookie": sessionCookie(token, secure) },
      });
    }

    await store.noteAttempt(ip, Date.now(), THROTTLE_WINDOW_MS);
    const user = await store.userByName(nameStr.toLowerCase());
    // Always run a verify so a missing account and a wrong password take a
    // similar amount of time.
    const okPass = await verifyPassword(passStr, user?.pass ?? DUMMY_HASH);
    if (!user || !okPass) return fail(401, "Wrong name or password.");
    await store.clearAttempts(ip);
    const token = await startSession(store, user.id);
    return json(await stateFor(store, user), {
      headers: { "set-cookie": sessionCookie(token, secure) },
    });
  }

  if (path === "/api/logout") {
    if (method !== "POST") return fail(405, "Method not allowed");
    await endSession(store, tokenFrom(req));
    return json({ ok: true }, { headers: { "set-cookie": clearCookie(secure) } });
  }

  if (path === "/api/me") {
    const user = await currentUser(store, req);
    return user ? json(await stateFor(store, user)) : json({ user: null });
  }

  /* --- public reads ----------------------------------------------- */

  if (path === "/api/leaderboard") {
    return json({ rows: await store.leaderboard(100) });
  }

  if (path === "/api/gallery") {
    const rows = (await store.recentArt(24)).map((r) => ({
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
    const row = await store.artByShare(art[1]!);
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
    const user = await currentUser(store, req);
    if (!user) return fail(401, "Sign in first.");
    const key = prog[1]!;
    if (!isValidKey(key)) return fail(400, "Unknown puzzle.");

    if (method === "GET") {
      return json({ art: await store.getProgress(user.id, key) });
    }
    if (method === "PUT") {
      const body = await readJson(req);
      if (!body) return fail(400, "Bad request");
      // Round-trip through the decoder so we never persist a malformed blob.
      const grid = decodeGrid(body.art);
      if (!grid) return fail(400, "That canvas is not a canvas.");
      await store.putProgress(user.id, key, encodeGrid(grid), Date.now());
      return json({ ok: true });
    }
    return fail(405, "Method not allowed");
  }

  const solve = path.match(/^\/api\/solve\/([A-Za-z0-9-]{1,24})$/);
  if (solve) {
    if (method !== "POST") return fail(405, "Method not allowed");
    const user = await currentUser(store, req);
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

    const existing = await store.solve(user.id, key);
    if (existing) {
      return json({
        alreadySolved: true,
        points: 0,
        bonds: result.bonds,
        shareId: existing.share_id,
        ...(await stateFor(store, user)),
      });
    }

    const row = await store.insertSolve(
      user.id, key, result.puzzle.points, result.bonds, encodeGrid(grid), shareId(), Date.now(),
    );

    return json({
      alreadySolved: false,
      points: row.points,
      bonds: row.bonds,
      parBonds: result.puzzle.parBonds,
      shareId: row.share_id,
      ...(await stateFor(store, user)),
    });
  }

  return fail(404, "No such endpoint.");
}

/** Shared error envelope, so a thrown route never leaks a stack to the client. */
export async function handleApiSafe(req: Request, url: URL, deps: Deps): Promise<Response> {
  try {
    return await handleApi(req, url, deps);
  } catch (err) {
    console.error("api error", url.pathname, err);
    return fail(500, "Something broke on our end.");
  }
}
