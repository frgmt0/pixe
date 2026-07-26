import { describe, expect, test } from "bun:test";
import { decodeGrid, encodeGrid } from "./codec";
import { dailyKey, generate, isValidKey, ladderKey, pointsFor } from "./generate";
import { CELLS, EMPTY, GRID, HUE_COUNT } from "./palette";
import { emptyGrid, evaluateRule, makeCtx, ruleText, type Rule } from "./rules";
import { assess } from "./validate";
import { zoneCount, zoneMap, zoneOf } from "./zones";

const LADDER = Array.from({ length: 400 }, (_, i) => ladderKey(i + 1));
const DAILIES = Array.from({ length: 120 }, (_, i) =>
  dailyKey(new Date(Date.UTC(2026, 0, 1 + i * 3))),
);
const ALL_KEYS = [...LADDER, ...DAILIES];

describe("solvability", () => {
  test("every generated puzzle's reference solution validates clean", () => {
    for (const key of ALL_KEYS) {
      const { target } = generate(key);
      const a = assess(key, target);
      if (!a.solved) {
        const broken = a.puzzle.rules
          .map((r, i) => [r, a.evals[i]!] as const)
          .filter(([, e]) => e.status !== "ok")
          .map(([r, e]) => `${e.status} ${ruleText(r, a.puzzle.scheme)}`);
        throw new Error(`${key} unsolvable by its own target:\n  ${broken.join("\n  ")}`);
      }
      expect(a.empty).toBe(0);
    }
  });

  test("reference solutions are fully painted with real hues", () => {
    for (const key of ALL_KEYS) {
      const { target } = generate(key);
      for (let i = 0; i < CELLS; i++) {
        expect(target[i]).toBeGreaterThanOrEqual(0);
        expect(target[i]).toBeLessThan(HUE_COUNT);
      }
    }
  });
});

describe("determinism", () => {
  test("same key regenerates an identical puzzle and target", () => {
    for (const key of ALL_KEYS.slice(0, 40)) {
      const a = generate(key);
      const b = generate(key);
      expect(JSON.stringify(a.puzzle)).toBe(JSON.stringify(b.puzzle));
      expect(encodeGrid(a.target)).toBe(encodeGrid(b.target));
    }
  });

  test("different keys give different puzzles", () => {
    const seen = new Set(LADDER.slice(0, 60).map((k) => encodeGrid(generate(k).target)));
    expect(seen.size).toBe(60);
  });
});

describe("puzzle shape", () => {
  test("rule counts, point values and hue sets stay in range", () => {
    for (const key of ALL_KEYS) {
      const { puzzle } = generate(key);
      expect(puzzle.rules.length).toBeGreaterThanOrEqual(2);
      expect(puzzle.rules.length).toBeLessThanOrEqual(12);
      expect(puzzle.points).toBeGreaterThanOrEqual(3);
      expect(puzzle.points).toBeLessThanOrEqual(7);
      expect(puzzle.hueSet.length).toBeGreaterThanOrEqual(2);
      expect(puzzle.bonds.length).toBeGreaterThanOrEqual(0);
      expect(puzzle.bonds.length).toBeLessThanOrEqual(2);
      // Every zone must be covered by exactly one zone rule.
      const zoneRules = puzzle.rules.filter((r) => r.t === "zone");
      expect(zoneRules.length).toBe(zoneCount(puzzle.scheme));
      for (const r of zoneRules) expect(r.t === "zone" && r.hues.length).toBeGreaterThan(0);
    }
  });

  test("the point ladder actually gets harder", () => {
    const early = LADDER.slice(0, 3).map((k) => generate(k).puzzle.difficulty);
    const late = LADDER.slice(100, 130).map((k) => generate(k).puzzle.difficulty);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(avg(late)).toBeGreaterThan(avg(early));
  });

  test("bonds are never a pair some rule forbids from touching", () => {
    for (const key of ALL_KEYS) {
      const { puzzle } = generate(key);
      for (const b of puzzle.bonds) {
        for (const r of puzzle.rules) {
          if (r.t === "forbidAdj" || r.t === "farApart") {
            const clash = (r.a === b.a && r.b === b.b) || (r.a === b.b && r.b === b.a);
            expect(clash).toBe(false);
          }
        }
      }
    }
  });

  test("every rule renders to non-empty text", () => {
    for (const key of ALL_KEYS.slice(0, 80)) {
      const { puzzle } = generate(key);
      for (const r of puzzle.rules) {
        expect(ruleText(r, puzzle.scheme).length).toBeGreaterThan(8);
      }
    }
  });
});

describe("assessment", () => {
  test("an empty grid is never solved and reports every cell empty", () => {
    const a = assess("L1", emptyGrid());
    expect(a.solved).toBe(false);
    expect(a.empty).toBe(CELLS);
    expect(a.filled).toBe(0);
  });

  test("a single wrong cell breaks an otherwise perfect grid", () => {
    for (const key of LADDER.slice(0, 25)) {
      const { target, puzzle } = generate(key);
      const zoneRule = puzzle.rules.find((r) => r.t === "zone")!;
      const zmap = zoneMap(puzzle.scheme);
      const banned = [...Array(HUE_COUNT).keys()].find(
        (h) => zoneRule.t === "zone" && !zoneRule.hues.includes(h),
      );
      if (banned === undefined) continue;
      const victim = [...Array(CELLS).keys()].find(
        (i) => zoneRule.t === "zone" && zmap[i] === zoneRule.zone,
      )!;
      const g = Int8Array.from(target);
      g[victim] = banned;
      const a = assess(key, g);
      expect(a.solved).toBe(false);
      expect(a.badCells.has(victim)).toBe(true);
    }
  });

  test("a nearly-full grid with one hole is not solved", () => {
    const { target } = generate("L7");
    const g = Int8Array.from(target);
    g[2000] = EMPTY;
    const a = assess("L7", g);
    expect(a.solved).toBe(false);
    expect(a.empty).toBe(1);
  });

  test("bond count matches the reference par", () => {
    for (const key of LADDER.slice(0, 30)) {
      const { target, puzzle } = generate(key);
      expect(assess(key, target).bonds).toBe(puzzle.parBonds);
    }
  });
});

describe("rule primitives", () => {
  const zmap = new Uint8Array(CELLS);
  const ctx = (g: Int8Array) => makeCtx(g, zmap);

  function gridOf(fn: (x: number, y: number) => number): Int8Array {
    const g = new Int8Array(CELLS);
    for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) g[y * GRID + x] = fn(x, y);
    return g;
  }

  test("forbidAdj catches an orthogonal touch but allows a diagonal one", () => {
    const rule: Rule = { t: "forbidAdj", a: 0, b: 1 };
    const g = gridOf(() => 2);
    g[0] = 0;
    g[1] = 1;
    expect(evaluateRule(rule, g, ctx(g)).status).toBe("broken");

    const d = gridOf(() => 2);
    d[0] = 0;
    d[GRID + 1] = 1;
    expect(evaluateRule(rule, d, ctx(d)).status).toBe("ok");
  });

  test("farApart also catches the diagonal", () => {
    const rule: Rule = { t: "farApart", a: 0, b: 1 };
    const d = gridOf(() => 2);
    d[0] = 0;
    d[GRID + 1] = 1;
    expect(evaluateRule(rule, d, ctx(d)).status).toBe("broken");
  });

  test("requireAdj is pending while a fixable hole remains, broken once boxed in", () => {
    const rule: Rule = { t: "requireAdj", a: 0, b: 1 };
    const g = gridOf(() => 2);
    g[GRID * 5 + 5] = 0;
    g[GRID * 5 + 6] = EMPTY;
    expect(evaluateRule(rule, g, ctx(g)).status).toBe("pending");

    const boxed = gridOf(() => 2);
    boxed[GRID * 5 + 5] = 0;
    expect(evaluateRule(rule, boxed, ctx(boxed)).status).toBe("broken");
  });

  test("parity only accepts one colour of the checkerboard", () => {
    const rule: Rule = { t: "parity", a: 3, p: 0 };
    const good = gridOf((x, y) => ((x + y) % 2 === 0 ? 3 : 1));
    expect(evaluateRule(rule, good, ctx(good)).status).toBe("ok");
    const bad = gridOf(() => 3);
    expect(evaluateRule(rule, bad, ctx(bad)).status).toBe("broken");
  });

  test("noBlock rejects a solid 2x2 and reports all four cells", () => {
    const rule: Rule = { t: "noBlock", a: 5 };
    const g = gridOf(() => 1);
    g[0] = g[1] = g[GRID] = g[GRID + 1] = 5;
    const ev = evaluateRule(rule, g, ctx(g));
    expect(ev.status).toBe("broken");
    expect(ev.violations.length).toBe(4);
  });

  test("lonely and buddy are exact opposites on a pair", () => {
    const g = gridOf(() => 1);
    g[0] = 4;
    g[1] = 4;
    expect(evaluateRule({ t: "lonely", a: 4 }, g, ctx(g)).status).toBe("broken");
    expect(evaluateRule({ t: "buddy", a: 4 }, g, ctx(g)).status).toBe("ok");
  });

  test("quotaMin is broken only when it can no longer be reached", () => {
    const g = emptyGrid();
    g.fill(1, 0, CELLS - 5);
    // 5 empties left, needs 100 more of hue 2 -> impossible.
    expect(evaluateRule({ t: "quotaMin", a: 2, min: 100 }, g, ctx(g)).status).toBe("broken");
    // Needs 3 -> still reachable.
    expect(evaluateRule({ t: "quotaMin", a: 2, min: 3 }, g, ctx(g)).status).toBe("pending");
  });

  test("lineLimit counts per row independently of columns", () => {
    const g = gridOf((_, y) => (y === 0 ? 6 : 1));
    expect(evaluateRule({ t: "lineLimit", a: 6, axis: "row", max: 10 }, g, ctx(g)).status).toBe("broken");
    expect(evaluateRule({ t: "lineLimit", a: 6, axis: "col", max: 10 }, g, ctx(g)).status).toBe("ok");
  });

  test("border rules respect the band width", () => {
    const g = gridOf(() => 1);
    g[0] = 7; // corner, depth 0
    expect(evaluateRule({ t: "border", a: 7, mode: "never", d: 2 }, g, ctx(g)).status).toBe("broken");
    expect(evaluateRule({ t: "border", a: 7, mode: "only", d: 2 }, g, ctx(g)).status).toBe("ok");
  });
});

describe("zones", () => {
  test("every scheme assigns every cell to a zone in range", () => {
    for (const key of ALL_KEYS.slice(0, 120)) {
      const { puzzle } = generate(key);
      const n = zoneCount(puzzle.scheme);
      const m = zoneMap(puzzle.scheme);
      const hit = new Set<number>();
      for (let i = 0; i < CELLS; i++) {
        expect(m[i]).toBeLessThan(n);
        hit.add(m[i]!);
      }
      // No scheme may declare a zone it never actually uses.
      expect(hit.size).toBe(n);
    }
  });

  test("zoneMap agrees with zoneOf", () => {
    const { puzzle } = generate("L33");
    const m = zoneMap(puzzle.scheme);
    for (let y = 0; y < GRID; y += 7) {
      for (let x = 0; x < GRID; x += 5) {
        expect(m[y * GRID + x]).toBe(zoneOf(puzzle.scheme, x, y));
      }
    }
  });
});

describe("codec", () => {
  test("round-trips reference solutions exactly", () => {
    for (const key of ALL_KEYS.slice(0, 60)) {
      const { target } = generate(key);
      const back = decodeGrid(encodeGrid(target))!;
      expect(back).not.toBeNull();
      expect(Array.from(back)).toEqual(Array.from(target));
    }
  });

  test("round-trips grids containing empties", () => {
    const g = emptyGrid();
    g.fill(3, 100, 200);
    g.fill(7, 4000, CELLS);
    expect(Array.from(decodeGrid(encodeGrid(g))!)).toEqual(Array.from(g));
  });

  test("rejects junk instead of throwing", () => {
    for (const bad of ["", "zzz", "a", "a0", "aZZZZZZ", "b-1", 42, null, undefined, {}, "a1"]) {
      expect(decodeGrid(bad as unknown)).toBeNull();
    }
  });

  test("encoding an empty grid is tiny", () => {
    expect(encodeGrid(emptyGrid()).length).toBeLessThan(8);
  });
});

describe("keys", () => {
  test("accepts real keys and rejects malformed ones", () => {
    for (const k of ["L1", "L42", "L999999", "D2026-07-26"]) expect(isValidKey(k)).toBe(true);
    for (const k of ["", "L0", "L", "X1", "D2026-7-26", "D2026-13-45", "L1;DROP", "../etc"]) {
      expect(isValidKey(k)).toBe(false);
    }
  });

  test("pointsFor is monotonic in rule weight", () => {
    const few = pointsFor([{ t: "noBlock", a: 0 }]);
    const many = pointsFor([
      { t: "noBlock", a: 0 },
      { t: "farApart", a: 1, b: 2 },
      { t: "requireAdj", a: 3, b: 4 },
      { t: "lonely", a: 5 },
      { t: "parity", a: 6, p: 0 },
      { t: "quotaMin", a: 7, min: 10 },
    ]);
    expect(many.points).toBeGreaterThanOrEqual(few.points);
    expect(many.difficulty).toBeGreaterThan(few.difficulty);
  });
});
