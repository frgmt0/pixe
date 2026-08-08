import { describe, expect, test } from "bun:test";
import {
  extent,
  fitAt,
  fmtDuration,
  fmtDurationLong,
  fmtUsd,
  groupByRun,
  leastSquares,
  niceTicks,
  padExtent,
  solveTokens,
  toBenchRow,
  tpsOf,
  type BenchPoint,
} from "./bench";
import type { BenchGroupRow } from "../../shared/protocol";

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("leastSquares", () => {
  test("recovers an exact line", () => {
    const fit = leastSquares([
      { x: 0, y: 3 },
      { x: 1, y: 5 },
      { x: 2, y: 7 },
      { x: 10, y: 23 },
    ]);
    expect(fit).not.toBeNull();
    close(fit!.slope, 2, 1e-12);
    close(fit!.intercept, 3, 1e-12);
    close(fit!.r2, 1, 1e-12);
    expect(fit!.n).toBe(4);
    expect(fit!.x0).toBe(0);
    expect(fit!.x1).toBe(10);
  });

  test("matches the published fit for Anscombe's first set", () => {
    const xs = [10, 8, 13, 9, 11, 14, 6, 4, 12, 7, 5];
    const ys = [8.04, 6.95, 7.58, 8.81, 8.33, 9.96, 7.24, 4.26, 10.84, 4.82, 5.68];
    const fit = leastSquares(xs.map((x, i) => ({ x, y: ys[i]! })))!;
    expect(fit.slope).toBeCloseTo(0.5001, 4);
    expect(fit.intercept).toBeCloseTo(3.0001, 4);
    expect(fit.r2).toBeCloseTo(0.6665, 4);
  });

  test("a learning curve fits with a negative slope", () => {
    // Wall time falling as the agent works out the dialect.
    const pts = Array.from({ length: 40 }, (_, i) => ({ x: i, y: 90 - 1.5 * i }));
    const fit = leastSquares(pts)!;
    expect(fit.slope).toBeLessThan(0);
    close(fit.slope, -1.5, 1e-12);
    close(fitAt(fit, 0), 90, 1e-9);
  });

  test("is unmoved by large offsets — the centred sums are not a detail", () => {
    // Raw Σxy on epoch-millisecond x values loses most of its precision.
    const base = 1_760_000_000_000;
    const pts = Array.from({ length: 50 }, (_, i) => ({ x: base + i, y: 4 * i + 7 }));
    const fit = leastSquares(pts)!;
    expect(fit.slope).toBeCloseTo(4, 9);
    expect(fit.r2).toBeCloseTo(1, 9);
  });

  test("refuses degenerate input instead of inventing a slope", () => {
    expect(leastSquares([])).toBeNull();
    expect(leastSquares([{ x: 1, y: 1 }])).toBeNull();
    // Every x identical: the line is vertical and has no finite slope.
    expect(leastSquares([{ x: 3, y: 1 }, { x: 3, y: 9 }, { x: 3, y: 4 }])).toBeNull();
    // Non-finite values are dropped, and dropping enough of them is degenerate.
    expect(leastSquares([{ x: 1, y: NaN }, { x: 2, y: 4 }])).toBeNull();
  });

  test("reports r2 of zero for a flat y, not one", () => {
    const fit = leastSquares([{ x: 0, y: 5 }, { x: 1, y: 5 }, { x: 2, y: 5 }])!;
    close(fit.slope, 0);
    expect(fit.r2).toBe(0);
  });

  test("r2 is between 0 and 1 on noisy data", () => {
    const pts = Array.from({ length: 60 }, (_, i) => ({
      x: i,
      y: 100 - 0.8 * i + Math.sin(i * 2.7) * 12,
    }));
    const fit = leastSquares(pts)!;
    expect(fit.r2).toBeGreaterThan(0);
    expect(fit.r2).toBeLessThan(1);
  });
});

describe("axis helpers", () => {
  test("niceTicks lands on round numbers inside the range", () => {
    const ticks = niceTicks(0, 100, 5);
    expect(ticks[0]).toBe(0);
    expect(ticks.at(-1)).toBe(100);
    for (const t of ticks) expect(Number.isInteger(t)).toBe(true);
  });

  test("niceTicks does not drift on fractional steps", () => {
    for (const t of niceTicks(0, 1, 5)) {
      expect(t).toBe(Number(t.toFixed(6)));
    }
  });

  test("niceTicks degenerates safely", () => {
    expect(niceTicks(5, 5)).toEqual([5]);
    expect(niceTicks(NaN, 1)).toEqual([]);
  });

  test("extent and padExtent", () => {
    expect(extent([3, 1, 9, 4])).toEqual({ min: 1, max: 9 });
    expect(extent([])).toBeNull();
    const p = padExtent({ min: 0, max: 100 }, 0.1);
    // A count axis padded below zero would imply negative puzzles.
    expect(p.min).toBe(0);
    expect(p.max).toBe(110);
  });
});

describe("formatting", () => {
  test("fmtDuration picks a readable solve-scale unit", () => {
    expect(fmtDuration(4200)).toBe("4.2s");
    expect(fmtDuration(45_000)).toBe("45s");
    expect(fmtDuration(65_000)).toBe("1m 05s");
    expect(fmtDuration(900_000)).toBe("15m 00s");
    expect(fmtDuration(7_384_000)).toBe("2h 03m");
  });

  test("fmtDurationLong picks a readable ladder-scale unit", () => {
    expect(fmtDurationLong(6)).toBe("6.0h");
    expect(fmtDurationLong(34)).toBe("34h");
    expect(fmtDurationLong(74)).toBe("3d 2h");
    expect(fmtDurationLong(72)).toBe("3d");
    expect(fmtDurationLong(24 * 400)).toBe("1.1y");
  });

  test("usd keeps small figures from rounding to zero", () => {
    expect(fmtUsd(0.0042)).toBe("$0.0042");
    expect(fmtUsd(2.5)).toBe("$2.500");
    expect(fmtUsd(4_200_000)).toBe("$4.20M");
  });

  test("a negative slope reads as −$0.27, not $−0.27", () => {
    expect(fmtUsd(-0.27)).toBe("−$0.270");
    expect(fmtUsd(0)).toBe("$0");
  });
});

describe("toBenchRow", () => {
  const wire = (over: Partial<BenchGroupRow> = {}): BenchGroupRow => ({
    model: "FAKE-kestrel",
    provider: "fake-labs",
    verified: false,
    runs: 1,
    verifiedRuns: 0,
    solves: 58,
    complete: false,
    totalPoints: 400,
    effective_ms_per_solve: 60_000,
    median_wall_ms: 55_000,
    probes_per_solve: 2,
    abandoned: 1,
    abandon_rate: 0.02,
    tokensIn: 1000,
    tokensOut: 500,
    costMicro: 9000,
    config: null,
    maxRung: 59,
    run_id: "r1",
    first_at: 0,
    last_at: 1,
    ...over,
  });

  test("computes the projection client-side, since the grouped wire row never carries it", () => {
    const row = toBenchRow(wire(), 500);
    expect(row.projected_500_hours).toBeCloseTo((60_000 * 500) / 3_600_000, 9);
  });

  test("prefers a server-sent projection once one ships", () => {
    const raw = wire() as BenchGroupRow & { projected_500_hours: number };
    raw.projected_500_hours = 12.5;
    expect(toBenchRow(raw, 500).projected_500_hours).toBe(12.5);
  });

  test("passes the server's own `complete` straight through", () => {
    expect(toBenchRow(wire({ solves: 500, complete: true }), 500).complete).toBe(true);
    expect(toBenchRow(wire({ solves: 58, complete: false }), 500).complete).toBe(false);
  });

  test("falls back to inferring `complete` from `solves` if a stale response omits it", () => {
    // Simulates JSON crossing the wire from a server that predates the field —
    // a real runtime shape the compile-time `BenchGroupRow` type cannot express.
    const stale = { ...wire({ solves: 500 }) } as Record<string, unknown>;
    delete stale.complete;
    expect(toBenchRow(stale as unknown as BenchGroupRow, 500).complete).toBe(true);

    const staleShort = { ...wire({ solves: 499 }) } as Record<string, unknown>;
    delete staleShort.complete;
    expect(toBenchRow(staleShort as unknown as BenchGroupRow, 500).complete).toBe(false);
  });
});

describe("tpsOf", () => {
  test("declared tokens out over measured solve time", () => {
    // 58 solves at 60s effective = 3480s; 5000 tokens out / 3480s.
    const tps = tpsOf({ tokensOut: 5000, solves: 58, effective_ms_per_solve: 60_000 });
    expect(tps).toBeCloseTo(5000 / 3480, 9);
  });

  test("blank, not zero, when tokens out was never declared", () => {
    expect(tpsOf({ tokensOut: null, solves: 58, effective_ms_per_solve: 60_000 })).toBeNull();
  });

  test("blank when there is nothing to divide by", () => {
    expect(tpsOf({ tokensOut: 100, solves: 0, effective_ms_per_solve: 60_000 })).toBeNull();
  });
});

describe("self-reported fields", () => {
  const point = (over: Partial<BenchPoint>): BenchPoint => ({
    run_id: "r1",
    model: "claude-opus-5",
    provider: "anthropic",
    config: null,
    idx: 0,
    difficulty: 4,
    points: 4,
    wall_ms: 1000,
    tokens_in: null,
    tokens_out: null,
    cost_micro: null,
    ...over,
  });

  test("an unreported total stays null rather than becoming zero", () => {
    expect(solveTokens(point({}))).toBeNull();
    expect(solveTokens(point({ tokens_in: 0, tokens_out: 0 }))).toBe(0);
    expect(solveTokens(point({ tokens_in: 100 }))).toBe(100);
  });

  test("groupByRun keeps each run in chain order", () => {
    const g = groupByRun([
      point({ run_id: "a", idx: 2 }),
      point({ run_id: "b", idx: 0 }),
      point({ run_id: "a", idx: 0 }),
      point({ run_id: "a", idx: 1 }),
    ]);
    expect([...g.keys()].sort()).toEqual(["a", "b"]);
    expect(g.get("a")!.map((p) => p.idx)).toEqual([0, 1, 2]);
  });
});
