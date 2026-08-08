import { dialectPhase } from "../shared/dialect";
import { decodeGrid } from "../shared/codec";
import type { Grid } from "../shared/rules";
import { handleBench, handleBenchPoints } from "./bench";
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
  /**
   * The maintainer's registration secret for this deployment, read from Bun's
   * process env locally (`server/index.ts`) or the Workers env binding in
   * production (`worker/index.ts`). `undefined` when this deployment has none
   * configured, in which case no run served by it can ever be verified —
   * there is no key to compare `X-Pixe-Verified-Key` against.
   */
  verifiedKey: string | undefined;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/** Errors carry a machine code as well as a sentence — `public/agents.txt`
 *  publishes the code list, so a route that answers without one is off-spec. */
const fail = (status: number, error: string, code: string) => json({ error, code }, { status });

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export async function handleApi(req: Request, url: URL, deps: Deps): Promise<Response> {
  const { store } = deps;
  const path = url.pathname;

  // Registration, the chained sequence, submission and abandonment — every
  // route scoped to a single run, all under `/api/bench/runs`. Answers `null`
  // for anything it does not own, so this file stays the map of the API rather
  // than a copy of it. It goes first because `/api/bench/runs` would otherwise
  // be shadowed by nothing at all and fall through to the 404.
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
      model: r.model,
      provider: r.provider,
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
    if (!row) return fail(404, "No such artwork.", "not_found");

    // Derived through the run's own dialect, not the base generator: every run
    // plays a perturbed variant, so `generatePuzzle(key)` would reveal a set of
    // laws this board never had. The salt itself stays here — it is per-run, so
    // publishing it for one finished board would publish every other board in
    // that run.
    //
    // For a multi-phase rung the stored art is the *final* phase, so the laws
    // to print are that phase's — derived from the grids the run had accepted
    // for the phases before it, which is why they are carried on the row.
    const priors = phaseGridsOf(row.phase_grids);
    const { puzzle } = dialectPhase(row.dialect, row.puzzle_key, priors.length + 1, priors);
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
      model: row.model,
      provider: row.provider,
      config: row.config,
      points: row.points,
      bonds: row.bonds,
      art: row.art,
      at: row.created_at,
    });
  }

  return fail(404, "No such endpoint.", "not_found");
}

/** Shared error envelope, so a thrown route never leaks a stack to the client. */
export async function handleApiSafe(req: Request, url: URL, deps: Deps): Promise<Response> {
  try {
    return await handleApi(req, url, deps);
  } catch (err) {
    console.error("api error", url.pathname, err);
    return fail(500, "Something broke on our end.", "server_error");
  }
}

/** The accepted grids for a rung's earlier phases, as stored on its issue. */
function phaseGridsOf(json: string | null): Grid[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Grid[] = [];
  for (const s of parsed) {
    const g = decodeGrid(s);
    if (g) out.push(g);
  }
  return out;
}
