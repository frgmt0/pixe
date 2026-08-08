import { describe, expect, test } from "bun:test";
import { buildBenchGroups, buildBenchRows, summariseFromPoints, timeLedger, type BenchStore } from "./bench";
import { ISSUE_TTL_MS, type IssueSpan, type RunRow } from "./store";
import type { ChartPoint } from "../shared/protocol";

const run = (id: string, over: Partial<RunRow> = {}): RunRow => ({
  id,
  secret: "s",
  model: id,
  provider: "acme",
  config: null,
  dialect: "d",
  created_at: 1_000,
  last_at: 2_000,
  status: "closed",
  verified: 0,
  ...over,
});

const solve = (runId: string, idx: number, wallMs: number, over: Partial<ChartPoint> = {}): ChartPoint => ({
  run_id: runId,
  model: runId,
  provider: "acme",
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

describe("grouping — one row per (model, provider)", () => {
  // No issue ledgers in any of these: `effective_ms_per_solve` falls back to
  // mean solved time, which is exactly what these tests want to compare on.
  const emptyLedgers: BenchStore = {
    runs: async () => [],
    allSolvesForCharts: async () => [],
    issueDurations: async () => [],
  };

  const group = async (runs: RunRow[], solves: ChartPoint[], includeMembers = false) => {
    const runRows = await buildBenchRows(emptyLedgers, runs, solves);
    return buildBenchGroups(runRows, solves, includeMembers);
  };

  test("two runs of the same model and provider fold into one row", async () => {
    const a = run("a", { model: "gpt-x", provider: "openai" });
    const b = run("b", { model: "gpt-x", provider: "openai" });
    const solves = [solve("a", 0, 1_000), solve("b", 0, 1_000)];
    const rows = await group([a, b], solves);
    expect(rows.length).toBe(1);
    expect(rows[0]!.runs).toBe(2);
  });

  test("same model, different provider, stays two rows", async () => {
    const a = run("a", { model: "gpt-x", provider: "openai" });
    const b = run("b", { model: "gpt-x", provider: "azure" });
    const solves = [solve("a", 0, 1_000), solve("b", 0, 1_000)];
    const rows = await group([a, b], solves);
    expect(rows.length).toBe(2);
  });

  test("within an unverified group, more solves wins the representative slot", async () => {
    const ahead = run("ahead", { model: "gpt-x", provider: "openai", verified: 0 });
    const behind = run("behind", { model: "gpt-x", provider: "openai", verified: 0 });
    const solves = [
      ...[0, 1, 2].map((i) => solve("ahead", i, 9_000)),
      ...[0].map((i) => solve("behind", i, 1_000)),
    ];
    const rows = await group([ahead, behind], solves);
    expect(rows.length).toBe(1);
    expect(rows[0]!.run_id).toBe("ahead");
    expect(rows[0]!.solves).toBe(3);
    expect(rows[0]!.verified).toBe(false);
    expect(rows[0]!.verifiedRuns).toBe(0);
  });

  /**
   * The rule the whole feature exists to state: a verified run represents its
   * model even when an unverified sibling banked far more. Letting the bigger
   * unverified number win would make "verified" decorative — a badge that
   * never actually changes which numbers a reader sees.
   */
  test("a verified run represents the group even with far fewer solves", async () => {
    const bigUnverified = run("big", { model: "gpt-x", provider: "openai", verified: 0 });
    const smallVerified = run("small", { model: "gpt-x", provider: "openai", verified: 1 });
    const solves = [
      ...Array.from({ length: 40 }, (_, i) => solve("big", i, 5_000)),
      ...Array.from({ length: 4 }, (_, i) => solve("small", i, 5_000)),
    ];
    const rows = await group([bigUnverified, smallVerified], solves);
    expect(rows.length).toBe(1);
    expect(rows[0]!.run_id).toBe("small");
    expect(rows[0]!.verified).toBe(true);
    expect(rows[0]!.solves).toBe(4);
    expect(rows[0]!.runs).toBe(2);
    expect(rows[0]!.verifiedRuns).toBe(1);
  });

  test("within a verified pool, ties on solves break on effective time", async () => {
    const slow = run("slow", { model: "gpt-x", provider: "openai", verified: 1 });
    const fast = run("fast", { model: "gpt-x", provider: "openai", verified: 1 });
    const solves = [
      ...[0, 1].map((i) => solve("slow", i, 20_000)),
      ...[0, 1].map((i) => solve("fast", i, 4_000)),
    ];
    const rows = await group([slow, fast], solves);
    expect(rows[0]!.run_id).toBe("fast");
  });

  test("declared meter figures are summed for the representative, not averaged", async () => {
    const a = run("a", { model: "gpt-x", provider: "openai" });
    const solves = [
      solve("a", 0, 1_000, { tokens_in: 100, tokens_out: 20, cost_micro: 500 }),
      solve("a", 3, 1_000, { tokens_in: 200, tokens_out: 30, cost_micro: 700 }),
      solve("a", 1, 1_000), // reported nothing; must not count as a zero
    ];
    const rows = await group([a], solves);
    expect(rows[0]!.tokensIn).toBe(300);
    expect(rows[0]!.tokensOut).toBe(50);
    expect(rows[0]!.costMicro).toBe(1200);
    // The furthest chain position reached, not the count of solves (3).
    expect(rows[0]!.maxRung).toBe(3);
  });

  test("a run that declared nothing sums to null, never zero", async () => {
    const a = run("a", { model: "gpt-x", provider: "openai" });
    const rows = await group([a], [solve("a", 0, 1_000)]);
    expect(rows[0]!.tokensIn).toBeNull();
    expect(rows[0]!.tokensOut).toBeNull();
    expect(rows[0]!.costMicro).toBeNull();
  });

  test("members are attached only when asked for", async () => {
    const a = run("a", { model: "gpt-x", provider: "openai" });
    const solves = [solve("a", 0, 1_000)];
    expect((await group([a], solves, false))[0]!.members).toBeUndefined();
    const withMembers = (await group([a], solves, true))[0]!.members;
    expect(withMembers?.length).toBe(1);
    expect(withMembers?.[0]!.run_id).toBe("a");
  });

  test("the table ranks groups by progress, then pace — never averaged across a group", async () => {
    const leader = run("leader", { model: "model-a", provider: "p" });
    const behind = run("behind", { model: "model-b", provider: "p" });
    const solves = [
      ...[0, 1, 2].map((i) => solve("leader", i, 50_000)),
      solve("behind", 0, 1_000),
    ];
    const rows = await group([leader, behind], solves);
    expect(rows.map((r) => r.model)).toEqual(["model-a", "model-b"]);
  });
});
