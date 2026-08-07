import { describe, expect, test } from "bun:test";
import { buildBenchRows, summariseFromPoints, timeLedger, type BenchStore } from "./bench";
import { ISSUE_TTL_MS, type IssueSpan, type RunRow } from "./store";
import type { ChartPoint } from "../shared/protocol";

const run = (id: string, over: Partial<RunRow> = {}): RunRow => ({
  id,
  secret: "s",
  harness: id,
  config: null,
  operator_id: null,
  dialect: "d",
  created_at: 1_000,
  last_at: 2_000,
  status: "closed",
  ...over,
});

const solve = (runId: string, idx: number, wallMs: number, over: Partial<ChartPoint> = {}): ChartPoint => ({
  run_id: runId,
  harness: runId,
  config: null,
  idx,
  difficulty: 5,
  points: 5,
  wall_ms: wallMs,
  tokens_in: null,
  tokens_out: null,
  cost_micro: null,
  ...over,
});

const span = (idx: number, issued: number, closed: number | null, outcome: string | null): IssueSpan => ({
  idx,
  issued_at: issued,
  closed_at: closed,
  outcome,
});

describe("timeLedger", () => {
  test("sums closed issues and counts the abandons", () => {
    const l = timeLedger([
      span(0, 0, 10_000, "solved"),
      span(1, 20_000, 25_000, "abandoned"),
      span(2, 30_000, 60_000, "solved"),
    ]);
    expect(l.busyMs).toBe(45_000);
    expect(l.abandoned).toBe(1);
  });

  test("ignores the gap between issues", () => {
    // An hour between two ten-second boards is lunch, not thinking.
    const l = timeLedger([span(0, 0, 10_000, "solved"), span(1, 3_610_000, 3_620_000, "solved")]);
    expect(l.busyMs).toBe(20_000);
  });

  test("an open issue costs nothing yet", () => {
    expect(timeLedger([span(0, 0, null, null)]).busyMs).toBe(0);
  });

  test("caps a reaped issue at the TTL", () => {
    // The sweep runs hourly, so a reaped issue's closed_at overshoots the TTL.
    const l = timeLedger([span(0, 0, ISSUE_TTL_MS + 5 * 3_600_000, "abandoned")]);
    expect(l.busyMs).toBe(ISSUE_TTL_MS);
    expect(l.abandoned).toBe(1);
  });
});

describe("effective_ms_per_solve", () => {
  test("charges abandoned time to the solves that landed", () => {
    const row = summariseFromPoints(
      run("r"),
      [solve("r", 1, 10_000), solve("r", 3, 10_000)],
      [
        span(0, 0, 30_000, "abandoned"),
        span(1, 40_000, 50_000, "solved"),
        span(2, 60_000, 90_000, "abandoned"),
        span(3, 100_000, 110_000, "solved"),
      ],
    )!;
    expect(row.solved).toBe(2);
    expect(row.abandoned).toBe(2);
    expect(row.abandon_rate).toBe(0.5);
    expect(row.median_wall_ms).toBe(10_000);
    // 30 + 10 + 30 + 10 seconds held, over two banked boards.
    expect(row.effective_ms_per_solve).toBe(40_000);
  });

  test("falls back to mean solved time when there are no issue rows", () => {
    // Degrading to zero would rank an unmeasured run first, which is the one
    // failure mode this metric cannot afford.
    const row = summariseFromPoints(run("r"), [solve("r", 0, 10_000), solve("r", 1, 30_000)], [])!;
    expect(row.effective_ms_per_solve).toBe(20_000);
    expect(row.abandoned).toBe(0);
  });

  test("a run with no solves has no row", () => {
    expect(summariseFromPoints(run("r"), [], [span(0, 0, 1_000, "abandoned")])).toBeNull();
  });
});

describe("ranking", () => {
  const store = (issues: Record<string, IssueSpan[]>): BenchStore => ({
    runs: async () => [],
    allSolvesForCharts: async () => [],
    issueDurations: async (id) => issues[id] ?? [],
  });

  test("board-shopping does not buy a better rank", () => {
    // `shopper` has the faster median on the boards it banked, and loses
    // anyway, because the boards it walked away from are on its bill.
    const grinder = run("grinder");
    const shopper = run("shopper");

    const solves = [
      ...[0, 1, 2, 3].map((i) => solve("grinder", i, 60_000)),
      ...[1, 3, 5].map((i) => solve("shopper", i, 20_000)),
    ];
    const issues = {
      grinder: [0, 1, 2, 3].map((i) => span(i, i * 100_000, i * 100_000 + 60_000, "solved")),
      shopper: [
        span(0, 0, 90_000, "abandoned"),
        span(1, 100_000, 120_000, "solved"),
        span(2, 200_000, 290_000, "abandoned"),
        span(3, 300_000, 320_000, "solved"),
        span(4, 400_000, 490_000, "abandoned"),
        span(5, 500_000, 520_000, "solved"),
      ],
    };

    return buildBenchRows(store(issues), [grinder, shopper], solves).then((rows) => {
      const byId = new Map(rows.map((r) => [r.run_id, r]));
      expect(byId.get("shopper")!.median_wall_ms).toBeLessThan(byId.get("grinder")!.median_wall_ms);
      expect(byId.get("shopper")!.effective_ms_per_solve).toBeGreaterThan(
        byId.get("grinder")!.effective_ms_per_solve,
      );
      expect(rows[0]!.run_id).toBe("grinder");
      expect(rows[0]!.projected_1m_hours).toBeLessThan(rows[1]!.projected_1m_hours);
    });
  });

  test("runs with no solves are dropped, not ranked", async () => {
    const rows = await buildBenchRows(store({}), [run("a"), run("empty")], [solve("a", 0, 1_000)]);
    expect(rows.map((r) => r.run_id)).toEqual(["a"]);
  });
});

describe("declared fields", () => {
  test("an unreported figure stays null and the coverage is carried", () => {
    const row = summariseFromPoints(
      run("r"),
      [
        solve("r", 0, 1_000, { tokens_in: 100, tokens_out: 50, cost_micro: 400 }),
        solve("r", 1, 1_000),
        solve("r", 2, 1_000, { tokens_in: 200, tokens_out: 50 }),
      ],
      [],
    )!;
    expect(row.tokens_per_solve).toBe(200); // (150 + 250) / 2, not / 3
    expect(row.tokens_reported).toBe(2);
    expect(row.cost_per_solve_micro).toBe(400);
    expect(row.cost_reported).toBe(1);
  });

  test("a run that declared nothing reports null rather than zero", () => {
    const row = summariseFromPoints(run("r"), [solve("r", 0, 1_000)], [])!;
    expect(row.tokens_per_solve).toBeNull();
    expect(row.cost_per_solve_micro).toBeNull();
    expect(row.projected_1m_cost_usd).toBeNull();
  });
});
