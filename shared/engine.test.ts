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

  /**
   * The one that nearly shipped broken.
   *
   * Every primitive except `zone` names specific hues, so a player who simply
   * never paints those hues satisfies all of them vacuously. A zone rule that
   * only permits hues is then happy with a solid fill, and the entire puzzle
   * reduces to one bucket click per region — worth full points, for no
   * deduction at all. It measured 96% of the ladder.
   *
   * The `each` coverage floor is what closes it. These two probes are the
   * cheap-strategy ladder: fill each zone solid, then fill it solid and poke
   * in one token cell of every other permitted hue. Both must fail everywhere.
   */
  describe("cheap strategies do not beat puzzles", () => {
    const solidPerZone = function* (palettes: number[][]): Generator<number[]> {
      const idx = new Array(palettes.length).fill(0);
      for (;;) {
        yield idx.map((v, i) => palettes[i]![v]!);
        let k = palettes.length - 1;
        while (k >= 0 && ++idx[k]! >= palettes[k]!.length) { idx[k] = 0; k--; }
        if (k < 0) return;
      }
    };

    const zoneInfo = (key: string) => {
      const { puzzle } = generate(key);
      const zmap = zoneMap(puzzle.scheme);
      const palettes = puzzle.rules
        .filter((r): r is Extract<Rule, { t: "zone" }> => r.t === "zone")
        .sort((a, b) => a.zone - b.zone)
        .map((r) => r.hues);
      return { zmap, palettes };
    };

    test("no puzzle falls to one solid hue per zone", () => {
      for (const key of LADDER.slice(0, 120)) {
        const { zmap, palettes } = zoneInfo(key);
        for (const combo of solidPerZone(palettes)) {
          const g = new Int8Array(CELLS);
          for (let i = 0; i < CELLS; i++) g[i] = combo[zmap[i]!]!;
          if (assess(key, g).solved) {
            throw new Error(`${key} solved by solid zone fill [${combo}]`);
          }
        }
      }
    });

    test("no puzzle falls to a solid zone plus token cells of the other hues", () => {
      for (const key of LADDER.slice(0, 120)) {
        const { zmap, palettes } = zoneInfo(key);
        const cells: number[][] = palettes.map(() => []);
        for (let i = 0; i < CELLS; i++) cells[zmap[i]!]!.push(i);

        for (let base = 0; base < 4; base++) {
          for (let off = 0; off < 6; off++) {
            const g = new Int8Array(CELLS);
            for (let i = 0; i < CELLS; i++) {
              const pal = palettes[zmap[i]!]!;
              g[i] = pal[base % pal.length]!;
            }
            for (let z = 0; z < palettes.length; z++) {
              const pal = palettes[z]!;
              const list = cells[z]!;
              let slot = off;
              for (const h of pal) {
                if (h === pal[base % pal.length]) continue;
                g[list[(slot * 137 + off * 29) % list.length]!] = h;
                slot += 7;
              }
            }
            if (assess(key, g).solved) {
              throw new Error(`${key} solved by token-diversity fill (base ${base}, off ${off})`);
            }
          }
        }
      }
    });
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

  /**
   * The game never states its rules, so every failure must be visible as
   * either glowing cells or a reacting swatch. A broken rule that shows
   * neither is an unwinnable dead end on a fully painted grid.
   *
   * Two distinct obligations, and the difference matters:
   *
   *   `broken`  — always visible. Something is wrong right now.
   *   `pending` — may be silent, but only while blank cells remain. A rule
   *               that is merely unfinished must NOT glow, or the board would
   *               be nagging about requirements the player hasn't been told
   *               about and cannot yet have broken. On a full grid there is no
   *               "yet", so silence there would be a dead end.
   */
  test("no failure is ever silent, on any grid state", () => {
    for (const key of LADDER.slice(0, 60)) {
      const { target, puzzle } = generate(key);
      const zmap = zoneMap(puzzle.scheme);

      // Probe a spread of states: empty, full-but-wrong, and the target with
      // increasingly large regions scribbled over in a single hue.
      const probes: Int8Array[] = [emptyGrid()];
      for (const h of puzzle.hueSet) {
        const solid = new Int8Array(CELLS);
        solid.fill(h);
        probes.push(solid);
      }
      for (const frac of [0.1, 0.5, 0.9]) {
        const g = Int8Array.from(target);
        g.fill(puzzle.hueSet[0]!, 0, Math.floor(CELLS * frac));
        probes.push(g);
      }

      for (const g of probes) {
        const ctx = makeCtx(g, zmap);
        const full = !g.includes(EMPTY);
        for (const rule of puzzle.rules) {
          const ev = evaluateRule(rule, g, ctx);
          if (ev.status === "ok") continue;
          if (ev.status === "pending") {
            // Reachable-but-unmet is only a legitimate silence while there is
            // still somewhere to put the missing paint.
            expect(full).toBe(false);
            continue;
          }
          const visible = ev.violations.length > 0 || ev.hue !== null;
          if (!visible) {
            throw new Error(
              `${key}: ${ev.status} rule with no feedback channel: ${ruleText(rule, puzzle.scheme)}`,
            );
          }
        }
      }
    }
  });

  test("quotaMax reports through the swatch, not by torching the canvas", () => {
    const g = new Int8Array(CELLS);
    g.fill(4);
    const ev = evaluateRule({ t: "quotaMax", a: 4, max: 10 }, g, makeCtx(g, new Uint8Array(CELLS)));
    expect(ev.status).toBe("broken");
    expect(ev.violations.length).toBe(0);
    expect(ev.hue).toBe(4);
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
