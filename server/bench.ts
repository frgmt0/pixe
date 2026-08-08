/**
 * The benchmark endpoints: `/api/bench` and `/api/bench/points`.
 *
 * There is no maths in this file. Every formula the table depends on — median,
 * p90, the two projections, the ranking — lives in `shared/protocol.ts` and is
 * imported, because a second implementation anywhere is a guarantee that the
 * table and the charts will eventually disagree. What is left here is the part
 * that genuinely belongs to the server: how many rows to read, how to fold a
 * flat projection back into per-run buckets, and what the response looks like.
 *
 * Aggregation happens in TypeScript over raw rows rather than in SQL because
 * `median` and `percentile_cont` do not exist in SQLite, and the window
 * functions D1 offers are not the ones `bun:sqlite` compiles with. A benchmark
 * whose headline number differs between the Bun process and the Worker is worse
 * than no benchmark, so both backends run one portable `SELECT` and the
 * arithmetic happens above them.
 */

import {
  byEffectiveTime,
  byGroupProgress,
  byProgress,
  median,
  percentile,
  projected1mCostUsd,
  projected1mHours,
  PUZZLE_UNIVERSE,
  type BenchGroupRow,
  type BenchRow as WireBenchRow,
  type BenchPointsBody,
  type ChartPoint,
} from "../shared/protocol";
import { ISSUE_TTL_MS, type IssueSpan, type RunRow } from "./store";

/** How many solve rows the aggregate is allowed to consider. */
const DEFAULT_POINTS = 5_000;
const MAX_POINTS = 25_000;
const DEFAULT_RUNS = 120;
const MAX_RUNS = 500;

/**
 * The slice of `Store` these handlers touch, declared structurally so the
 * router can hand them its full `Deps` unchanged and a test can hand them
 * arrays.
 */
export interface BenchStore {
  runs(limit: number): Promise<RunRow[]>;
  allSolvesForCharts(limit: number): Promise<ChartPoint[]>;
  issueDurations(runId: string): Promise<IssueSpan[]>;
}

/**
 * The wire row, unchanged. `effective_ms_per_solve`, `abandoned` and
 * `abandon_rate` now live in `shared/protocol.ts` alongside the rest of the
 * row, so there is nothing left to widen here.
 */
export type BenchRow = WireBenchRow;

/**
 * The model-grouped row `/api/bench` actually serves. Defined once in
 * `shared/protocol.ts` — see it there for what each field means and why the
 * representative is a real run's numbers rather than an average.
 */
export type { BenchGroupRow };

export interface BenchBody {
  rows: BenchGroupRow[];
  universe: number;
  pointsConsidered: number;
  truncated: boolean;
  generatedAt: number;
}

export interface BenchDeps {
  store: BenchStore;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function clampParam(url: URL, name: string, fallback: number, max: number): number {
  const raw = Number(url.searchParams.get(name));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.floor(raw), max);
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

/**
 * Total time a run held a board, and how many boards it walked away from.
 *
 * Issue *durations* are summed rather than `last_at - first_at`: the gap
 * between one issue closing and the next opening is an agent that stopped for
 * lunch or a harness that fell over overnight, and charging that as thinking
 * time would be its own kind of dishonest.
 *
 * A still-open issue contributes nothing — it is unfinished work, not time
 * spent — and every closed one is capped at the TTL the reaper enforces, so a
 * run that crashed mid-board is charged for the window it was allowed to hold
 * the board and not for the days until someone noticed.
 */
export function timeLedger(issues: readonly IssueSpan[]): { busyMs: number; abandoned: number } {
  let busyMs = 0;
  let abandoned = 0;
  for (const issue of issues) {
    if (issue.closed_at == null) continue;
    busyMs += Math.min(Math.max(0, issue.closed_at - issue.issued_at), ISSUE_TTL_MS);
    if (issue.outcome === "abandoned") abandoned++;
  }
  return { busyMs, abandoned };
}

/**
 * Folds one run's solves into a table row.
 *
 * `protocol.summarizeRun` does the same job from full `RunSolveRow`s; this
 * builds the row from the flat `ChartPoint` projection instead, because the
 * charts and the table are served from one `SELECT` and the wide row carries an
 * encoded 4096-cell canvas per solve that nobody here reads. The formulas are
 * the imported ones, so the two paths cannot drift.
 */
export function summariseFromPoints(
  run: RunRow,
  solves: readonly ChartPoint[],
  issues: readonly IssueSpan[],
): BenchRow | null {
  if (solves.length === 0) return null;

  const walls = solves.map((s) => s.wall_ms);
  const medianWall = median(walls);

  const { busyMs, abandoned } = timeLedger(issues);
  // Time spent on solved boards is definitionally part of the total, so it is
  // also the floor. That makes the metric degrade honestly rather than
  // catastrophically if the issues rows are ever missing: without them the
  // effective figure collapses to mean solved time instead of to zero, which
  // would rank an unmeasured run first.
  const solvedMs = walls.reduce((a, b) => a + b, 0);
  const effectiveMs = Math.round(Math.max(busyMs, solvedMs) / solves.length);

  // Averaged over the solves that declared a figure, not over all of them:
  // padding the rest with zeros would invent a cheaper agent than the one that
  // played. `tokens_reported` carries the coverage so the UI can say so.
  const tokened = solves.filter((s) => s.tokens_in !== null || s.tokens_out !== null);
  const costed = solves.filter((s) => s.cost_micro !== null);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  const tokensPerSolve = tokened.length
    ? Math.round(sum(tokened.map((s) => (s.tokens_in ?? 0) + (s.tokens_out ?? 0))) / tokened.length)
    : null;
  const costPerSolveMicro = costed.length
    ? Math.round(sum(costed.map((s) => s.cost_micro!)) / costed.length)
    : null;

  return {
    run_id: run.id,
    model: run.model,
    provider: run.provider,
    config: run.config,
    status: run.status,
    // `RunRow.verified` is the SQLite/D1-native 0|1; this is the one place it
    // becomes the wire's `boolean`.
    verified: run.verified === 1,

    solved: solves.length,
    points: sum(solves.map((s) => s.points)),
    // Mean rather than median: probe counts are small integers, and a median
    // over a handful of them lands on a whole number that hides real
    // differences between runs.
    probes_per_solve: solves.length
      ? Math.round((sum(solves.map((s) => s.probes ?? 0)) / solves.length) * 10) / 10
      : 0,
    // Optional on ChartPoint: real the moment the column joins the projection.
    bonds: sum(solves.map((s) => s.bonds ?? 0)),

    median_wall_ms: medianWall,
    p90_wall_ms: percentile(walls, 90),
    effective_ms_per_solve: effectiveMs,
    abandoned,
    abandon_rate: abandoned + solves.length === 0 ? 0 : abandoned / (abandoned + solves.length),

    tokens_per_solve: tokensPerSolve,
    cost_per_solve_micro: costPerSolveMicro,
    tokens_reported: tokened.length,
    cost_reported: costed.length,

    // Projected from the effective figure, not the median, so board-shopping
    // cannot buy a better number here.
    projected_1m_hours: projected1mHours(effectiveMs),
    projected_1m_cost_usd:
      costPerSolveMicro === null ? null : projected1mCostUsd(costPerSolveMicro),

    first_at: run.created_at,
    last_at: run.last_at,
  };
}

/**
 * The rankings moved to `shared/protocol.ts` and are re-exported here.
 *
 * The table re-sorts client-side when a reader toggles a column, so a
 * comparator that lived only on the server would have had a second
 * implementation in the browser — and two answers to "which run is ahead" on
 * one page is precisely what the rest of this file exists to avoid.
 * `byGroupProgress` is what `/api/bench` itself serves now; `byEffectiveTime`
 * and `byProbes` remain available for the per-run `members` list.
 */
export { byEffectiveTime, byProbes, byProgress, byGroupProgress } from "../shared/protocol";

export async function buildBenchRows(
  store: BenchStore,
  runs: readonly RunRow[],
  solves: readonly ChartPoint[],
): Promise<BenchRow[]> {
  const byRun = new Map<string, ChartPoint[]>();
  for (const s of solves) {
    const bucket = byRun.get(s.run_id);
    if (bucket) bucket.push(s);
    else byRun.set(s.run_id, [s]);
  }

  // Only runs that banked something need an issue ledger, and they are fetched
  // together rather than in sequence — on D1 this is one round trip per run and
  // the difference between concurrent and serial is the difference between a
  // fast page and a slow one.
  const scored = runs.filter((r) => (byRun.get(r.id)?.length ?? 0) > 0);
  const ledgers = await Promise.all(scored.map((r) => store.issueDurations(r.id)));

  const rows: BenchRow[] = [];
  for (const [i, run] of scored.entries()) {
    const row = summariseFromPoints(run, byRun.get(run.id) ?? [], ledgers[i] ?? []);
    if (row) rows.push(row);
  }
  return rows.sort(byEffectiveTime);
}

/* ------------------------------------------------------------------ */
/* Grouping -- one row per (model, provider)                          */
/* ------------------------------------------------------------------ */

interface DeclaredSums {
  tokensIn: number | null;
  tokensOut: number | null;
  costMicro: number | null;
  maxRung: number | null;
}

/**
 * Sums, not means -- a model-grouped row wants "how much did clearing this
 * much ladder cost", not a per-solve average duplicating what `BenchRow`
 * already gives the per-run view. Null when the run reported nothing at all
 * for that figure on any solve, never zero; `maxRung` is the furthest chain
 * position the run's own issues reached, which includes abandoned boards --
 * "how far in", not "how many landed".
 */
function declaredSums(points: readonly ChartPoint[]): DeclaredSums {
  let tokensIn = 0;
  let tokensOut = 0;
  let costMicro = 0;
  let hasTokensIn = false;
  let hasTokensOut = false;
  let hasCost = false;
  let maxIdx = -1;
  for (const p of points) {
    if (p.tokens_in != null) {
      tokensIn += p.tokens_in;
      hasTokensIn = true;
    }
    if (p.tokens_out != null) {
      tokensOut += p.tokens_out;
      hasTokensOut = true;
    }
    if (p.cost_micro != null) {
      costMicro += p.cost_micro;
      hasCost = true;
    }
    if (p.idx > maxIdx) maxIdx = p.idx;
  }
  return {
    tokensIn: hasTokensIn ? tokensIn : null,
    tokensOut: hasTokensOut ? tokensOut : null,
    costMicro: hasCost ? costMicro : null,
    maxRung: points.length ? maxIdx : null,
  };
}

/**
 * Folds per-run rows into one row per `(model, provider)`.
 *
 * Grouped with a `Map<model, Map<provider, BenchRow[]>>` rather than a joined
 * string key -- `model` and `provider` are free text with no separator either
 * one is forbidden from containing, so `"A B"`/`"C"` and `"A"`/`"B C"` would
 * collide on any string delimiter. Nesting the maps sidesteps the question
 * instead of trying to pick a character neither field can contain.
 *
 * The representative is chosen by `byProgress` -- most ladder progress, pace as
 * the tiebreak -- over a pool that is the group's *verified* runs when there
 * are any, and the whole group otherwise. That "verified strictly preferred"
 * rule is deliberate and absolute: a model with one verified run at 40 solves
 * and one unverified run at 400 is represented by the 40-solve run, because
 * the alternative -- letting an unverified run's numbers stand in for a model
 * just because they are more flattering -- is exactly the thing a verified
 * badge exists to prevent someone from doing.
 *
 * `members` (every run in the group, individually) is attached only when the
 * caller asked for it -- see `handleBench`'s `?members=1`.
 */
export function buildBenchGroups(
  runRows: readonly BenchRow[],
  solves: readonly ChartPoint[],
  includeMembers: boolean,
): BenchGroupRow[] {
  const byRun = new Map<string, ChartPoint[]>();
  for (const s of solves) {
    const bucket = byRun.get(s.run_id);
    if (bucket) bucket.push(s);
    else byRun.set(s.run_id, [s]);
  }

  const groups = new Map<string, Map<string, BenchRow[]>>();
  for (const row of runRows) {
    let byProvider = groups.get(row.model);
    if (!byProvider) {
      byProvider = new Map();
      groups.set(row.model, byProvider);
    }
    const bucket = byProvider.get(row.provider);
    if (bucket) bucket.push(row);
    else byProvider.set(row.provider, [row]);
  }

  const out: BenchGroupRow[] = [];
  for (const byProvider of groups.values()) {
    for (const members of byProvider.values()) {
      const verifiedMembers = members.filter((m) => m.verified);
      const pool = verifiedMembers.length ? verifiedMembers : members;
      const rep = pool.reduce((best, cur) => (byProgress(cur, best) < 0 ? cur : best));
      const sums = declaredSums(byRun.get(rep.run_id) ?? []);

      out.push({
        model: rep.model,
        provider: rep.provider,
        verified: rep.verified,
        runs: members.length,
        verifiedRuns: verifiedMembers.length,

        solves: rep.solved,
        totalPoints: rep.points,

        effective_ms_per_solve: rep.effective_ms_per_solve,
        median_wall_ms: rep.median_wall_ms,
        probes_per_solve: rep.probes_per_solve,
        abandoned: rep.abandoned,
        abandon_rate: rep.abandon_rate,

        tokensIn: sums.tokensIn,
        tokensOut: sums.tokensOut,
        costMicro: sums.costMicro,

        config: rep.config,
        maxRung: sums.maxRung,

        run_id: rep.run_id,
        first_at: rep.first_at,
        last_at: rep.last_at,

        ...(includeMembers ? { members: [...members] } : {}),
      });
    }
  }

  return out.sort(byGroupProgress);
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

export async function handleBench(req: Request, url: URL, deps: BenchDeps): Promise<Response> {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, { status: 405 });

  const pointLimit = clampParam(url, "points", DEFAULT_POINTS, MAX_POINTS);
  const runLimit = clampParam(url, "runs", DEFAULT_RUNS, MAX_RUNS);
  // Named `members`, not `runs`: `?runs=` already means "how many rows the
  // aggregation may consider" (above), which is unrelated to whether each
  // group's individual runs are unfolded in the response.
  const includeMembers = url.searchParams.get("members") === "1";

  const [runs, solves] = await Promise.all([
    deps.store.runs(runLimit),
    deps.store.allSolvesForCharts(pointLimit),
  ]);

  const runRows = await buildBenchRows(deps.store, runs, solves);
  const body: BenchBody = {
    rows: buildBenchGroups(runRows, solves, includeMembers),
    universe: PUZZLE_UNIVERSE,
    pointsConsidered: solves.length,
    truncated: solves.length >= pointLimit,
    generatedAt: Date.now(),
  };
  // The table is public and identical for everyone, which is exactly the shape
  // that attracts a reload storm; fifteen seconds absorbs it.
  return json(body, { headers: { "cache-control": "public, max-age=15" } });
}

export async function handleBenchPoints(
  req: Request,
  url: URL,
  deps: BenchDeps,
): Promise<Response> {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, { status: 405 });

  const limit = clampParam(url, "limit", DEFAULT_POINTS, MAX_POINTS);
  const points = await deps.store.allSolvesForCharts(limit);
  const run = url.searchParams.get("run");

  const body: BenchPointsBody = {
    points: run ? points.filter((p) => p.run_id === run) : points,
  };
  return json(body, { headers: { "cache-control": "public, max-age=15" } });
}
