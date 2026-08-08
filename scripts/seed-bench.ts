/**
 * Fills a throwaway database with fabricated benchmark runs so the bench
 * screen has a shape to render, and — with `--serve` — puts the two bench
 * endpoints on a port of their own.
 *
 *   PIXE_DB=./data/bench.sqlite bun run scripts/seed-bench.ts
 *   PIXE_DB=./data/bench.sqlite bun run scripts/seed-bench.ts --serve
 *
 * `--serve` exists because `/api/bench` is wired into `router.ts` by the lead
 * agent, and the charts had to be verified against a live response before that
 * landed. It calls the same handlers `router.ts` will, through the same
 * `bun:sqlite` store, so what it proves is real. Delete it once the routes are
 * wired if it has stopped earning its place.
 *
 * Every model here is named `FAKE-…` and every provider `fake-…`. That is not
 * decoration: a seeded database that looks plausible is exactly the thing that
 * ends up screenshotted as a result. The configs are shaped like real ones — a
 * planner-and-subagents line, a plain single-model line — because the column
 * has to be exercised as the free prose it is rather than as a tidy enum.
 */

import { encodeGrid } from "../shared/codec";
import { CELLS } from "../shared/palette";
import { Rng } from "../shared/prng";
import { handleBench, handleBenchPoints } from "../server/bench";
import { sqliteStore } from "../server/store-sqlite";
import type { RunRow } from "../server/store";

interface Recipe {
  /** The benchmarked identity, declared by the run and never checked for
   *  truth — only `verified` below says anything about where a run started. */
  model: string;
  provider: string;
  /**
   * Whether this run carried the maintainer's key at registration. Most seed
   * runs do not, because most real runs will not either. Two of the recipes
   * below deliberately share a `(model, provider)` pair with an earlier one —
   * one verified, one not — so the seeded table actually exercises grouping
   * and the "verified is preferred outright" rule rather than only ever
   * showing one run per model.
   */
  verified: boolean;
  /** Free prose about the setup. Displayed under the model and ranked by nothing. */
  config: string | null;
  solves: number;
  /** Seconds on the first puzzle. */
  start: number;
  /** Seconds the run converges toward. */
  floor: number;
  /** Puzzles it takes to close most of that gap. Infinity = never learns. */
  halfLife: number;
  /** Spread of the per-puzzle noise, as a fraction. */
  jitter: number;
  /**
   * Scales how many looks at the board a solve costs, independently of the
   * clock.
   *
   * This dial exists so the seed can show the one thing the probes column is
   * for: the two metrics answering different questions. A run behind a slow
   * endpoint is last on time and unremarkable on probes; a run that brute-forces
   * is quick on the clock and by far the worst on probes. Tying probes to the
   * time curve alone would have produced the same order twice and made a sort
   * toggle look broken.
   */
  probeFactor: number;
  /**
   * Chance of walking away from a board before solving it, applied repeatedly,
   * so a high value produces several abandons per solve. This is the
   * board-shopping dial: `FAKE-avocet` has the fastest median on the page and
   * the worst effective figure, which is the pair the table exists to show.
   */
  abandonRate: number;
  /** Time spent before giving up, as a fraction of what a solve would cost. */
  giveUpAt: number;
  /**
   * How often the run declares tokens and cost. Most runs declare nothing at
   * all — the endpoints are optional and the page has to look right that way,
   * so that is the case the seed data is mostly made of.
   */
  declaresTokens: number;
  declaresCost: number;
  /** Declared tokens per second of thinking, roughly. */
  tokenRate: number;
  /** Declared USD per million tokens. */
  usdPerMTok: number;
}

const RECIPES: Recipe[] = [
  {
    model: "FAKE-kestrel", provider: "fake-labs", verified: false, config: "demo-model-a",
    solves: 58, start: 96, floor: 21, halfLife: 14, jitter: 0.3, probeFactor: 1,
    abandonRate: 0.04, giveUpAt: 0.9,
    declaresTokens: 1, declaresCost: 1, tokenRate: 620, usdPerMTok: 9,
  },
  {
    model: "FAKE-heron", provider: "fake-labs", verified: false,
    config: "demo-model-b planner + demo-model-a subagents",
    solves: 44, start: 132, floor: 44, halfLife: 20, jitter: 0.34, probeFactor: 0.9,
    abandonRate: 0.1, giveUpAt: 1.1,
    declaresTokens: 0, declaresCost: 0, tokenRate: 0, usdPerMTok: 0,
  },
  {
    model: "FAKE-shrike", provider: "fake-cloud", verified: false, config: "demo-model-a, screenshots only",
    solves: 36, start: 190, floor: 74, halfLife: 26, jitter: 0.28, probeFactor: 1.1,
    abandonRate: 0.06, giveUpAt: 1.2,
    declaresTokens: 1, declaresCost: 1, tokenRate: 410, usdPerMTok: 14,
  },
  {
    // Never gets faster: the flat fit is a result, and the page has to show it.
    // It never gets thriftier with its looks either, which is the same result
    // said in the other column.
    model: "FAKE-plover", provider: "fake-cloud", verified: false, config: "demo-model-c",
    solves: 27, start: 88, floor: 88, halfLife: Infinity, jitter: 0.42, probeFactor: 1.4,
    abandonRate: 0, giveUpAt: 1,
    declaresTokens: 0, declaresCost: 0, tokenRate: 0, usdPerMTok: 0,
  },
  {
    // Config is optional, and a run without one has to render as a blank rather
    // than as anything that reads like a value.
    model: "FAKE-godwit", provider: "fake-labs", verified: false, config: null,
    solves: 19, start: 154, floor: 60, halfLife: 9, jitter: 0.26, probeFactor: 0.95,
    abandonRate: 0.12, giveUpAt: 0.8,
    declaresTokens: 1, declaresCost: 0, tokenRate: 900, usdPerMTok: 0,
  },
  {
    // The board shopper, and the brute-forcer. Second-fastest on the clock,
    // worst on the page by probes: it paints and resubmits until something
    // sticks and drops whatever does not. Sorting by probes has to move it from
    // near the top to the bottom, or the column is not being read.
    model: "FAKE-avocet", provider: "fake-cloud", verified: false,
    config: "demo-model-c, 8 parallel painters",
    solves: 12, start: 41, floor: 17, halfLife: 5, jitter: 0.22, probeFactor: 3.4,
    abandonRate: 0.62, giveUpAt: 0.7,
    declaresTokens: 0.35, declaresCost: 0.35, tokenRate: 1500, usdPerMTok: 22,
  },
  {
    // The slow endpoint. Last on the clock by a wide margin and mid-table on
    // probes, because a congested provider changes how long a run takes and not
    // how many times it had to look at the board.
    model: "FAKE-dunlin", provider: "fake-labs", verified: false,
    config: "demo-model-d, rate-limited endpoint",
    solves: 6, start: 240, floor: 120, halfLife: 30, jitter: 0.5, probeFactor: 0.8,
    abandonRate: 0.35, giveUpAt: 1.4,
    declaresTokens: 0, declaresCost: 0, tokenRate: 0, usdPerMTok: 0,
  },
  /**
   * Two recipes below share a `(model, provider)` with one above, and that is
   * not an oversight — it is the only way to seed a page that actually
   * exercises `/api/bench`'s grouping instead of only ever showing one run per
   * model. Both `?members=1` and the group-vs-representative fold have
   * nothing to fold over otherwise.
   */
  {
    // Same model and provider as FAKE-kestrel above, but registered with the
    // maintainer's key and with far fewer solves. It still has to win the
    // representative slot — that is the whole point of "verified" outranking
    // "more solves" rather than the other way round.
    model: "FAKE-kestrel", provider: "fake-labs", verified: true,
    config: "demo-model-a, maintainer's machine",
    solves: 21, start: 91, floor: 24, halfLife: 12, jitter: 0.24, probeFactor: 0.85,
    abandonRate: 0.02, giveUpAt: 0.9,
    declaresTokens: 1, declaresCost: 1, tokenRate: 600, usdPerMTok: 9,
  },
  {
    // Same model and provider as FAKE-heron above, neither verified, so the
    // group is decided the ordinary way: most solves first, pace as the
    // tiebreak — this one has more solves than the original FAKE-heron and
    // must win the slot on that basis alone.
    model: "FAKE-heron", provider: "fake-labs", verified: false,
    config: "demo-model-b planner + demo-model-a subagents, retry x2",
    solves: 51, start: 129, floor: 41, halfLife: 18, jitter: 0.31, probeFactor: 0.92,
    abandonRate: 0.08, giveUpAt: 1.05,
    declaresTokens: 0, declaresCost: 0, tokenRate: 0, usdPerMTok: 0,
  },
];

const HOUR = 3_600_000;


/**
 * A grid that actually decodes.
 *
 * The placeholder string that used to sit here was not a valid encoding, so
 * every seeded share page rendered its undecodable state — which meant the one
 * screen nobody could check while developing was the one the seeder existed to
 * populate. Blocky rather than random: the real codec is run-length, and 4096
 * confetti cells would produce a share row an order of magnitude larger than
 * any genuine solve.
 */

/**
 * Probes for a seeded solve.
 *
 * Falls with experience and rises with difficulty, because that is the shape
 * the real metric should have — an agent that has worked out the law family
 * needs fewer looks at the board, and a harder board needs more. Seeding it
 * flat would make the probes column look like noise and hide whether the
 * table is reading it correctly.
 *
 * `probeFactor` is then the run's own thrift, and it is what stops probes from
 * being a restatement of the clock: the two columns must be able to disagree
 * about which run is ahead, because that disagreement is the entire reason the
 * probes column exists.
 */
function probesFor(rng: Rng, r: Recipe, idx: number, difficulty: number): number {
  // The learning shape is the recipe's own rather than a second one invented
  // here, so a run that gets faster on the clock also gets thriftier with its
  // looks — and a run with `halfLife: Infinity` stays stubbornly expensive on
  // both.
  const learned = Number.isFinite(r.halfLife) ? Math.exp(-idx / r.halfLife) : 1;
  const base = 3 + difficulty * 0.55;
  const shape = base * (0.55 + learned) * (1 + (rng.next() - 0.5) * r.jitter);
  return Math.max(1, Math.round(shape * r.probeFactor));
}

function fakeArt(rng: Rng): string {
  const g = new Int8Array(CELLS);
  for (let i = 0; i < CELLS; ) {
    const run = Math.min(rng.range(8, 96), CELLS - i);
    g.fill(rng.range(0, 7), i, i + run);
    i += run;
  }
  return encodeGrid(g as never);
}

async function seed(): Promise<void> {
  const store = sqliteStore();
  const now = Date.now();

  for (const [n, r] of RECIPES.entries()) {
    const rng = new Rng(`pixe/seed-bench/${r.model}`);
    const id = `FAKESEED${String(n).padStart(2, "0")}${rng.int(1e5).toString(36)}`.slice(0, 16);
    const startedAt = now - (RECIPES.length - n) * 6 * HOUR;

    const run: RunRow = {
      id,
      secret: `seed-not-a-secret-${n}`,
      model: r.model,
      provider: r.provider,
      config: r.config,
      dialect: `seed-dialect-${n}`,
      created_at: startedAt,
      last_at: startedAt,
      status: "closed",
      verified: r.verified ? 1 : 0,
    };
    await store.createRun(run);

    let at = startedAt;
    // The chain's index counts *issues*, not solves, so an abandoned board
    // consumes one. That is what makes the learning curve's x-axis honest for a
    // shopper: the gaps are the boards it walked away from.
    let idx = 0;
    let abandoned = 0;

    const durationFor = (nth: number, difficulty: number) => {
      const decay = r.halfLife === Infinity ? 1 : Math.exp(-nth / r.halfLife);
      const trend = r.floor + (r.start - r.floor) * decay;
      // Harder boards genuinely take longer, which is what stops the learning
      // curve from being a clean exponential and gives the fit something to do.
      const byDifficulty = trend * (0.7 + difficulty * 0.09);
      const noise = 1 + (rng.next() - 0.5) * 2 * r.jitter;
      return Math.max(2_000, Math.round(byDifficulty * noise * 1000));
    };

    for (let nth = 0; nth < r.solves; nth++) {
      while (rng.next() < r.abandonRate) {
        const held = Math.round(durationFor(nth, rng.range(3, 7)) * r.giveUpAt);
        await store.insertIssue(id, idx, `L${idx + 1}`, at);
        await store.closeIssue(id, idx, at + held, "abandoned");
        at += held + rng.range(1_500, 9_000);
        idx++;
        abandoned++;
      }

      // Difficulty is drawn across the full 3–7 band rather than ramped, so
      // the cost-against-difficulty plot has something to fit at every x.
      const difficulty = rng.range(3, 7);
      const wall_ms = durationFor(nth, difficulty);

      // A rung's points are the sum over its phases (migration 0004): 3-12 for
      // a single board, up to 36 for a three-phase rung deep in the ladder.
      // The ceiling widening with chain position is a loose echo of
      // `phaseCountFor` — early rungs stay single-phase, later ones stack —
      // without actually simulating phases in fabricated data.
      const phaseCeiling = idx < 20 ? 12 : idx < 45 ? 24 : 36;
      const points = rng.range(3, phaseCeiling);

      const reportsTokens = rng.next() < r.declaresTokens;
      const reportsCost = reportsTokens && rng.next() < r.declaresCost / Math.max(r.declaresTokens, 1e-9);
      const total = Math.round((wall_ms / 1000) * r.tokenRate * (0.8 + rng.next() * 0.4));
      const tokensIn = reportsTokens ? Math.round(total * 0.78) : null;
      const tokensOut = reportsTokens ? total - Math.round(total * 0.78) : null;

      await store.insertIssue(id, idx, `L${idx + 1}`, at);
      await store.closeIssue(id, idx, at + wall_ms, "solved");
      at += wall_ms;
      await store.insertRunSolve({
        run_id: id,
        idx,
        puzzle_key: `L${idx + 1}`,
        points,
        bonds: rng.range(0, 14),
        difficulty,
        wall_ms,
        api_calls: rng.range(6, 40),
        probes: probesFor(rng, r, idx, difficulty),
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_micro: reportsCost ? Math.round((total / 1_000_000) * r.usdPerMTok * 1_000_000) : null,
        art: fakeArt(rng),
        share_id: `fakeseed${n}x${nth.toString(36)}`,
        created_at: at,
      });
      at += rng.range(1_500, 9_000);
      idx++;
    }
    await store.touchRun(id, at);
    console.log(
      `  ${r.model.padEnd(14)} ${String(r.solves).padStart(3)} solves  ${String(abandoned).padStart(3)} abandoned`,
    );
  }
}

function serve(): void {
  const store = sqliteStore();
  const port = Number(process.env.PORT ?? 3001);

  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const deps = { store };
      if (url.pathname === "/api/bench") return handleBench(req, url, deps);
      if (url.pathname === "/api/bench/points") return handleBenchPoints(req, url, deps);
      return new Response(JSON.stringify({ error: "seed-bench serves only /api/bench*" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });
  console.log(`seed-bench: /api/bench and /api/bench/points on http://localhost:${port}`);
}

if (process.argv.includes("--serve")) {
  serve();
} else {
  console.log(`seeding ${process.env.PIXE_DB ?? "./data/pixe.sqlite"} with FABRICATED runs`);
  await seed();
  console.log("done — every model here is named FAKE-… on purpose");
}
