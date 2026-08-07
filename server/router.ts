import { dialectPuzzle } from "../shared/dialect";
import { handleBench, handleBenchPoints } from "./bench";
import { handlePairApi } from "./pairing";
import { handleRunApi, type RunDeps } from "./runs";
import type { Store } from "./store";

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

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export async function handleApi(req: Request, url: URL, deps: Deps): Promise<Response> {
  const { store } = deps;
  const path = url.pathname;

  // Pairing goes first and deliberately so. It owns `POST /api/run` outright,
  // and it intercepts `GET /api/run/me` only while a run is still `pending` —
  // handing back `null` the moment it is paired, so the run handler below
  // answers everything else. Reversing these two would let a run register
  // without a human ever being asked to vouch for it.
  const paired = await handlePairApi(req, url, deps);
  if (paired) return paired;

  // The chained sequence, attestation and submission — every route scoped to a
  // single run. Answers `null` for anything it does not own, so this file stays
  // the map of the API rather than a copy of it.
  const run = await handleRunApi(req, url, deps satisfies RunDeps);
  if (run) return run;

  /* --- the benchmark ---------------------------------------------- */

  if (path === "/api/bench") return handleBench(req, url, deps);
  if (path === "/api/bench/points") return handleBenchPoints(req, url, deps);

  /* --- public reads ------------------------------------------------ */

  if (path === "/api/gallery") {
    const rows = (await store.recentArt(24)).map((r) => ({
      shareId: r.share_id,
      key: r.puzzle_key,
      harness: r.harness,
      config: r.config,
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

    // Derived through the run's own dialect, not the base generator: every run
    // plays a perturbed variant, so `generatePuzzle(key)` would reveal a set of
    // laws this board never had. The salt itself stays here — it is per-run, so
    // publishing it for one finished board would publish every other board in
    // that run.
    const { puzzle } = dialectPuzzle(row.dialect, row.puzzle_key);
    return json({
      shareId: row.share_id,
      key: row.puzzle_key,
      title: puzzle.title,
      // Safe to reveal: this board is solved and banked, and the reveal is the
      // whole point of the share page.
      rules: puzzle.rules,
      scheme: puzzle.scheme,
      bondPairs: puzzle.bonds,
      parBonds: puzzle.parBonds,
      harness: row.harness,
      config: row.config,
      points: row.points,
      bonds: row.bonds,
      art: row.art,
      at: row.created_at,
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
