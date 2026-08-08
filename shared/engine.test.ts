import { beforeAll, describe, expect, test } from "bun:test";
import { decodeGrid, encodeGrid } from "./codec";
import {
  dailyKey, generate, isValidKey, ladderKey, LADDER_SIZE, phaseCountFor, POINTS_MAX,
  POINTS_MIN, pointsFor, tierFor,
} from "./generate";
import { CELLS, EMPTY, GRID, HUE_COUNT } from "./palette";
import {
  buzzedHues, emptyGrid, evaluateRule, makeCtx, ruleChannel, ruleText, type Rule, type RuleKind,
} from "./rules";
import { assess } from "./validate";
import { zoneCount, zoneMap, zoneOf } from "./zones";

/**
 * 400 keys spread across the whole ladder rather than its first 400 rungs.
 * Difficulty is a fraction of `LADDER_SIZE` now, so a sweep of L1-L400 on a
 * 500-rung ladder would test five tiers and skip the two hardest ones.
 */
const LADDER = Array.from({ length: 400 }, (_, i) =>
  ladderKey(1 + Math.round((i * (LADDER_SIZE - 1)) / 399)),
);
const DAILIES = Array.from({ length: 120 }, (_, i) =>
  dailyKey(new Date(Date.UTC(2026, 0, 1 + i * 3))),
);
const ALL_KEYS = [...LADDER, ...DAILIES];

/**
 * Generating a puzzle costs ~11ms, because every board is adversarially
 * hardened against no-thought fills before it is accepted. `generate` memoises,
 * so paying for the whole corpus once here keeps that cost out of the
 * individual tests — otherwise the first test in each block pays it again and
 * trips the default timeout, which looks like a failure but is only a warm-up.
 */
beforeAll(() => {
  for (const key of ALL_KEYS) generate(key);
}, 60_000);

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
      expect(puzzle.rules.length).toBeLessThanOrEqual(24);
      expect(puzzle.points).toBeGreaterThanOrEqual(POINTS_MIN);
      expect(puzzle.points).toBeLessThanOrEqual(POINTS_MAX);
      expect(puzzle.hueSet.length).toBeGreaterThanOrEqual(2);
      expect(puzzle.bonds.length).toBeGreaterThanOrEqual(0);
      expect(puzzle.bonds.length).toBeLessThanOrEqual(2);
      // Every zone must be covered by exactly one zone rule.
      const zoneRules = puzzle.rules.filter((r) => r.t === "zone");
      expect(zoneRules.length).toBe(zoneCount(puzzle.scheme));
      for (const r of zoneRules) expect(r.t === "zone" && r.hues.length).toBeGreaterThan(0);
    }
  });

  /**
   * The difficulty curve, band by band rather than end to end.
   *
   * "Late is harder than early" was true of a two-tier ladder and would still
   * pass if tiers 2, 3 and 4 were all identical. What the benchmark actually
   * promises is that a rung gets harder the whole way up, so every adjacent
   * pair of tiers is compared and every one of them has to move.
   */
  test("difficulty climbs at every tier boundary", () => {
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
    const byTier = new Map<number, number[]>();
    for (const key of LADDER) {
      const t = tierFor(key);
      const list = byTier.get(t) ?? [];
      list.push(generate(key).puzzle.difficulty);
      byTier.set(t, list);
    }
    const tiers = [...byTier.keys()].sort((a, b) => a - b);
    expect(tiers.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < tiers.length; i++) {
      const lo = avg(byTier.get(tiers[i - 1]!)!);
      const hi = avg(byTier.get(tiers[i]!)!);
      if (hi <= lo) {
        throw new Error(`tier ${tiers[i]} (${hi.toFixed(1)}) is no harder than tier ${tiers[i - 1]} (${lo.toFixed(1)})`);
      }
    }
  });

  /** Phases are part of the curve: the opening is one board, the top is three. */
  test("the phase count climbs with the ladder and never exceeds three", () => {
    let last = 0;
    for (let n = 1; n <= LADDER_SIZE; n++) {
      const p = phaseCountFor(ladderKey(n));
      expect(p).toBeGreaterThanOrEqual(1);
      expect(p).toBeLessThanOrEqual(3);
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
    expect(phaseCountFor(ladderKey(1))).toBe(1);
    expect(phaseCountFor(ladderKey(LADDER_SIZE))).toBe(3);
  });

  /**
   * A family that no board can ever derive is a family that does not exist.
   *
   * Every primitive here is planted for, or computed off, the reference
   * solution — and each of those paths is a place a refactor can quietly stop
   * producing anything. This is the check that notices.
   */
  test("every law family actually appears somewhere on the ladder", () => {
    const seen = new Set<RuleKind>();
    for (const key of LADDER) for (const r of generate(key).puzzle.rules) seen.add(r.t);
    const expected: RuleKind[] = [
      "zone", "forbidAdj", "requireAdj", "farApart", "quotaMin", "quotaMax", "lineLimit",
      "parity", "noBlock", "buddy", "lonely", "border",
      "product", "lattice", "knight", "boxCap", "runCap", "runMod", "reach", "regions",
      "mirror", "exclusive", "relCount", "halfTilt", "zoneCount", "countMod",
    ];
    const missing = expected.filter((k) => !seen.has(k));
    expect(missing).toEqual([]);
  });

  /** The opening has to stay an opening: no exotic families, one phase. */
  test("the bottom of the ladder is still the twelve original primitives", () => {
    const classic = new Set<RuleKind>([
      "zone", "forbidAdj", "requireAdj", "farApart", "quotaMin", "quotaMax", "lineLimit",
      "parity", "noBlock", "buddy", "lonely", "border",
    ]);
    for (let n = 1; n <= 3; n++) {
      const { puzzle } = generate(ladderKey(n));
      expect(puzzle.phases).toBe(1);
      for (const r of puzzle.rules) expect(classic.has(r.t)).toBe(true);
    }
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

    // The explicit timeout is not papering over a slow test: this one assesses
    // the full cartesian product of per-zone hues across 120 boards, which is
    // tens of thousands of `assess` calls and legitimately runs for seconds on
    // a slower machine. The default 5s is close enough to that to fail on
    // timing alone, which reads as a broken generator rather than a busy CPU.
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
    }, 30_000);

    /**
     * The strategy after solid fills, and a sneakier one: a mechanical pattern
     * clears the coverage floor by construction and is accidentally good at
     * constraint satisfaction — a checkerboard alone gives you `lonely`,
     * `noBlock`, `parity` and `requireAdj`. This measured 21% of the ladder
     * before the generator started adversarially hardening against it.
     *
     * Deliberately re-implemented here rather than reusing the generator's own
     * decoy set, and routed through `assess` — the same entry point the server
     * validates with. Sharing that code would make the test tautological: the
     * generator would be graded by exactly the check it optimises against, and
     * any drift between it and real validation would go unseen.
     */
    // 120 keys × 10 patterns × 4 rotations of full-board assessment outgrew
    // the default 5s budget when the law menu went from 12 families to 26.
    test("no puzzle falls to a mechanical pattern fill", () => {
      const patterns: ((x: number, y: number) => number)[] = [
        (x, y) => x + y,
        (x, y) => y,
        (x, y) => x,
        (x, y) => (x >> 1) + (y >> 1),
        (x, y) => (x + y) >> 2,
        (x, y) => y >> 2,
        (x, y) => x >> 2,
        // Three that only became dangerous with the arithmetic families: a hue
        // laid down on x^y satisfies a surprising number of modular laws, and
        // x*y satisfies `product` outright for entirely the wrong reason.
        (x, y) => x ^ y,
        (x, y) => x * y,
        (x, y) => (x * 3 + y * 5) >> 1,
      ];
      for (const key of LADDER.slice(0, 120)) {
        const { zmap, palettes } = zoneInfo(key);
        for (const pat of patterns) {
          for (let rot = 0; rot < 4; rot++) {
            const g = new Int8Array(CELLS);
            for (let i = 0; i < CELLS; i++) {
              const pal = palettes[zmap[i]!]!;
              g[i] = pal[(pat(i % GRID, (i / GRID) | 0) + rot) % pal.length]!;
            }
            if (assess(key, g).solved) {
              throw new Error(`${key} solved by a mechanical pattern fill (rot ${rot})`);
            }
          }
        }
      }
    }, 60_000);

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
    }, 60_000);
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
          // Not merely "something came back", but that it came back on the
          // channel the primitive claims. `ruleChannel` is the contract an
          // agent's solver is written against: a `cell` law promises flashes
          // and a `swatch` law promises a colour name, and a family that
          // quietly changed sides would break every solver that trusted it.
          const flashes = ev.violations.length;
          const buzzes = buzzedHues(ev).length;
          const channel = ruleChannel(rule);
          const visible =
            channel === "cell" ? flashes > 0 : channel === "swatch" ? buzzes > 0 : flashes + buzzes > 0;
          if (!visible) {
            throw new Error(
              `${key}: ${ev.status} ${channel}-channel rule with no feedback: ${ruleText(rule, puzzle.scheme)}`,
            );
          }
        }
      }
    }
  });

  /**
   * The same invariant stated per primitive rather than per board.
   *
   * The sweep above only exercises the families the corpus happened to derive
   * on the grids it happened to probe. This one builds a grid that breaks each
   * primitive on purpose, so every one of the twenty-six has its broken branch
   * walked with an assertion on which channel it spoke through.
   */
  test("every primitive reports on the channel it claims, when deliberately broken", () => {
    const zmap = new Uint8Array(CELLS);
    const solid = (h: number) => {
      const g = new Int8Array(CELLS);
      g.fill(h);
      return g;
    };
    const at = (g: Int8Array, x: number, y: number, h: number) => {
      g[y * GRID + x] = h;
      return g;
    };

    const cases: [Rule, Int8Array][] = [
      [{ t: "zone", zone: 0, hues: [1], each: 2 }, at(solid(1), 3, 3, 5)],
      [{ t: "locked", cells: [{ i: 0, h: 2 }] }, solid(1)],
      [{ t: "forbidAdj", a: 1, b: 2 }, at(solid(1), 5, 5, 2)],
      [{ t: "requireAdj", a: 2, b: 3 }, at(solid(1), 5, 5, 2)],
      [{ t: "farApart", a: 1, b: 2 }, at(solid(1), 5, 5, 2)],
      [{ t: "quotaMax", a: 1, max: 10 }, solid(1)],
      [{ t: "quotaMin", a: 2, min: 10 }, solid(1)],
      [{ t: "parity", a: 1, p: 0 }, solid(1)],
      [{ t: "noBlock", a: 1 }, solid(1)],
      [{ t: "lineLimit", a: 1, axis: "row", max: 5 }, solid(1)],
      [{ t: "buddy", a: 2 }, at(solid(1), 5, 5, 2)],
      [{ t: "lonely", a: 1 }, solid(1)],
      [{ t: "border", a: 1, mode: "never", d: 2 }, solid(1)],
      [{ t: "product", a: 1, k: 3, r: 0 }, solid(1)],
      [{ t: "lattice", a: 1, axis: "sum", k: 3, r: 0 }, solid(1)],
      [{ t: "knight", a: 1 }, solid(1)],
      [{ t: "boxCap", a: 1, r: 1, max: 4 }, solid(1)],
      [{ t: "runCap", a: 1, axis: "row", max: 4 }, solid(1)],
      [{ t: "runMod", a: 1, axis: "row", m: 5 }, solid(1)],
      [{ t: "reach", a: 2 }, at(solid(1), 30, 30, 2)],
      [{ t: "regions", a: 1, k: 3 }, solid(1)],
      [{ t: "mirror", a: 2, op: "flipX" }, at(solid(1), 5, 5, 2)],
      [{ t: "exclusive", a: 1, b: 2, axis: "row" }, at(solid(1), 5, 5, 2)],
      [{ t: "relCount", a: 2, b: 1, tenths: 10, cmp: "atLeast" }, at(solid(1), 5, 5, 2)],
      [{ t: "halfTilt", a: 1, axis: "h", heavy: 0, margin: 50 }, solid(1)],
      [{ t: "zoneCount", a: 1, zone: 0, cmp: "atMost", n: 10 }, solid(1)],
      [{ t: "countMod", a: 1, m: 3, r: 0 }, solid(1)],
    ];

    const covered = new Set<RuleKind>();
    for (const [rule, grid] of cases) {
      const ev = evaluateRule(rule, grid, makeCtx(grid, zmap));
      if (ev.status !== "broken") throw new Error(`${rule.t} was meant to be broken here, got ${ev.status}`);
      const channel = ruleChannel(rule);
      const flashes = ev.violations.length;
      const buzzes = buzzedHues(ev).length;
      if (channel === "cell" && flashes === 0) throw new Error(`${rule.t} claims the cell channel but flashed nothing`);
      if (channel === "swatch" && buzzes === 0) throw new Error(`${rule.t} claims the swatch channel but buzzed nothing`);
      if (channel === "both" && flashes + buzzes === 0) throw new Error(`${rule.t} said nothing at all`);
      covered.add(rule.t);
    }
    // Every primitive in the union has a case above. A new family added without
    // one is a family with no channel test, which is how a silent law ships.
    expect(covered.size).toBe(cases.length);
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

  /* --- the families beyond the original twelve --------------------- */

  test("product bans a residue class of x times y and nothing else", () => {
    const rule: Rule = { t: "product", a: 4, k: 3, r: 1 };
    // 1 x 1 = 1, which is the banned class.
    const bad = gridOf(() => 1);
    bad[GRID + 1] = 4;
    expect(evaluateRule(rule, bad, ctx(bad)).status).toBe("broken");
    // 1 x 2 = 2, which is not.
    const good = gridOf(() => 1);
    good[2 * GRID + 1] = 4;
    expect(evaluateRule(rule, good, ctx(good)).status).toBe("ok");
  });

  test("lattice generalises parity to any modulus and any axis", () => {
    const rule: Rule = { t: "lattice", a: 3, axis: "sum", k: 3, r: 0 };
    const good = gridOf((x, y) => ((x + y) % 3 === 0 ? 3 : 1));
    expect(evaluateRule(rule, good, ctx(good)).status).toBe("ok");
    const bad = gridOf((x, y) => ((x + y) % 3 === 1 ? 3 : 1));
    expect(evaluateRule(rule, bad, ctx(bad)).status).toBe("broken");
    // The diff axis is a different question about the same cell.
    const diff: Rule = { t: "lattice", a: 3, axis: "diff", k: 3, r: 0 };
    expect(evaluateRule(diff, good, ctx(good)).status).toBe("broken");
  });

  test("knight catches two along and one across, but not a plain diagonal", () => {
    const rule: Rule = { t: "knight", a: 6 };
    const g = gridOf(() => 1);
    g[10 * GRID + 10] = 6;
    g[12 * GRID + 11] = 6;
    const ev = evaluateRule(rule, g, ctx(g));
    expect(ev.status).toBe("broken");
    expect(ev.violations.length).toBe(2);

    const d = gridOf(() => 1);
    d[10 * GRID + 10] = 6;
    d[11 * GRID + 11] = 6;
    expect(evaluateRule(rule, d, ctx(d)).status).toBe("ok");
  });

  test("boxCap is a local density ceiling, not a global one", () => {
    // Four in one 3x3 window, but only four on the whole board.
    const g = gridOf(() => 1);
    for (const [x, y] of [[10, 10], [11, 10], [10, 11], [11, 11]]) g[y! * GRID + x!] = 2;
    expect(evaluateRule({ t: "boxCap", a: 2, r: 1, max: 3 }, g, ctx(g)).status).toBe("broken");
    expect(evaluateRule({ t: "boxCap", a: 2, r: 1, max: 4 }, g, ctx(g)).status).toBe("ok");
    // Spread the same four out and the cap is fine.
    const spread = gridOf(() => 1);
    for (const [x, y] of [[0, 0], [20, 0], [0, 20], [20, 20]]) spread[y! * GRID + x!] = 2;
    expect(evaluateRule({ t: "boxCap", a: 2, r: 1, max: 3 }, spread, ctx(spread)).status).toBe("ok");
  });

  test("runCap measures along one axis only and never waits", () => {
    const g = gridOf(() => 1);
    for (let x = 0; x < 6; x++) g[5 * GRID + x] = 2;
    expect(evaluateRule({ t: "runCap", a: 2, axis: "row", max: 5 }, g, ctx(g)).status).toBe("broken");
    expect(evaluateRule({ t: "runCap", a: 2, axis: "col", max: 5 }, g, ctx(g)).status).toBe("ok");
    // A too-long run is wrong whatever happens to the blank cells elsewhere.
    const partial = Int8Array.from(g);
    partial[3000] = EMPTY;
    expect(evaluateRule({ t: "runCap", a: 2, axis: "row", max: 5 }, partial, ctx(partial)).status).toBe("broken");
  });

  test("runMod waits for a run to be sealed before judging its length", () => {
    const rule: Rule = { t: "runMod", a: 2, axis: "row", m: 2 };
    // Three in a row, bounded by hue 1 on both sides: settled, and odd.
    const sealed = gridOf(() => 1);
    for (let x = 5; x < 8; x++) sealed[5 * GRID + x] = 2;
    expect(evaluateRule(rule, sealed, ctx(sealed)).status).toBe("broken");

    // The same run with a blank beside it could still grow to four.
    const open = Int8Array.from(sealed);
    open[5 * GRID + 8] = EMPTY;
    expect(evaluateRule(rule, open, ctx(open)).status).toBe("pending");

    const even = gridOf(() => 1);
    for (let x = 5; x < 9; x++) even[5 * GRID + x] = 2;
    expect(evaluateRule(rule, even, ctx(even)).status).toBe("ok");
  });

  test("reach is pending for an island that could still bridge to the frame", () => {
    const rule: Rule = { t: "reach", a: 3 };
    const marooned = gridOf(() => 1);
    marooned[30 * GRID + 30] = 3;
    expect(evaluateRule(rule, marooned, ctx(marooned)).status).toBe("broken");

    const bridgeable = Int8Array.from(marooned);
    bridgeable[30 * GRID + 31] = EMPTY;
    expect(evaluateRule(rule, bridgeable, ctx(bridgeable)).status).toBe("pending");

    const touching = gridOf(() => 1);
    for (let y = 0; y <= 30; y++) touching[y * GRID + 30] = 3;
    expect(evaluateRule(rule, touching, ctx(touching)).status).toBe("ok");
  });

  test("regions counts islands and buzzes rather than flashing", () => {
    const g = gridOf(() => 1);
    g[10 * GRID + 10] = 5;
    g[40 * GRID + 40] = 5;
    const two = evaluateRule({ t: "regions", a: 5, k: 2 }, g, ctx(g));
    expect(two.status).toBe("ok");
    const one = evaluateRule({ t: "regions", a: 5, k: 1 }, g, ctx(g));
    expect(one.status).toBe("broken");
    expect(one.violations.length).toBe(0);
    expect(one.hue).toBe(5);
  });

  test("mirror waits on a blank image and complains about a painted one", () => {
    const rule: Rule = { t: "mirror", a: 7, op: "rot180" };
    const lopsided = gridOf(() => 1);
    lopsided[10 * GRID + 10] = 7;
    expect(evaluateRule(rule, lopsided, ctx(lopsided)).status).toBe("broken");

    const waiting = Int8Array.from(lopsided);
    waiting[(GRID - 1 - 10) * GRID + (GRID - 1 - 10)] = EMPTY;
    expect(evaluateRule(rule, waiting, ctx(waiting)).status).toBe("pending");

    const symmetric = Int8Array.from(lopsided);
    symmetric[(GRID - 1 - 10) * GRID + (GRID - 1 - 10)] = 7;
    expect(evaluateRule(rule, symmetric, ctx(symmetric)).status).toBe("ok");
  });

  test("exclusive is per line and flashes both colours in the offending one", () => {
    const rule: Rule = { t: "exclusive", a: 2, b: 3, axis: "row" };
    const clash = gridOf(() => 1);
    clash[5 * GRID + 1] = 2;
    clash[5 * GRID + 9] = 3;
    const ev = evaluateRule(rule, clash, ctx(clash));
    expect(ev.status).toBe("broken");
    expect(ev.violations.length).toBe(2);

    const apart = gridOf(() => 1);
    apart[5 * GRID + 1] = 2;
    apart[6 * GRID + 9] = 3;
    expect(evaluateRule(rule, apart, ctx(apart)).status).toBe("ok");
    // Same board, asked about columns instead: still fine, different question.
    expect(evaluateRule({ ...rule, axis: "col" }, apart, ctx(apart)).status).toBe("ok");
  });

  test("relCount implicates both colours it relates", () => {
    const g = gridOf(() => 1);
    for (let i = 0; i < 100; i++) g[i] = 2;
    // 100 of hue 2 against 3996 of hue 1: nowhere near half.
    const ev = evaluateRule({ t: "relCount", a: 2, b: 1, tenths: 5, cmp: "atLeast" }, g, ctx(g));
    expect(ev.status).toBe("broken");
    expect(new Set(buzzedHues(ev))).toEqual(new Set([1, 2]));
    expect(evaluateRule({ t: "relCount", a: 2, b: 1, tenths: 5, cmp: "atMost" }, g, ctx(g)).status).toBe("ok");
  });

  test("halfTilt measures one half against the other", () => {
    const g = gridOf((_, y) => (y < GRID / 2 ? 4 : 1));
    expect(evaluateRule({ t: "halfTilt", a: 4, axis: "h", heavy: 0, margin: 100 }, g, ctx(g)).status).toBe("ok");
    expect(evaluateRule({ t: "halfTilt", a: 4, axis: "h", heavy: 1, margin: 100 }, g, ctx(g)).status).toBe("broken");
    // Split evenly across the vertical axis, so a tilt that way is broken.
    expect(evaluateRule({ t: "halfTilt", a: 4, axis: "v", heavy: 0, margin: 100 }, g, ctx(g)).status).toBe("broken");
  });

  test("zoneCount is a quota with a region attached", () => {
    const zones = new Uint8Array(CELLS);
    for (let i = 0; i < CELLS; i++) zones[i] = i % GRID < GRID / 2 ? 0 : 1;
    const g = gridOf((x) => (x < GRID / 2 ? 4 : 1));
    const zctx = makeCtx(g, zones);
    expect(evaluateRule({ t: "zoneCount", a: 4, zone: 0, cmp: "atLeast", n: 2000 }, g, zctx).status).toBe("ok");
    expect(evaluateRule({ t: "zoneCount", a: 4, zone: 1, cmp: "atLeast", n: 1 }, g, zctx).status).toBe("broken");
    expect(evaluateRule({ t: "zoneCount", a: 4, zone: 0, cmp: "atMost", n: 100 }, g, zctx).status).toBe("broken");
  });

  test("countMod is reachable while any blank could change the residue", () => {
    const rule: Rule = { t: "countMod", a: 2, m: 3, r: 0 };
    const g = emptyGrid();
    g.fill(1, 0, CELLS - 5);
    g.fill(2, 0, 1); // one cell of hue 2, five blanks left
    expect(evaluateRule(rule, g, ctx(g)).status).toBe("pending");

    const full = gridOf(() => 1);
    full[0] = 2;
    expect(evaluateRule(rule, full, ctx(full)).status).toBe("broken");
    full[1] = 2;
    full[2] = 2;
    expect(evaluateRule(rule, full, ctx(full)).status).toBe("ok");
  });

  test("locked cells flash when wrong and stay quiet while blank", () => {
    const rule: Rule = { t: "locked", cells: [{ i: 100, h: 3 }, { i: 200, h: 4 }] };
    const right = gridOf(() => 1);
    right[100] = 3;
    right[200] = 4;
    expect(evaluateRule(rule, right, ctx(right)).status).toBe("ok");

    const wrong = Int8Array.from(right);
    wrong[100] = 5;
    const ev = evaluateRule(rule, wrong, ctx(wrong));
    expect(ev.status).toBe("broken");
    expect(ev.violations).toEqual([100]);

    const unpainted = Int8Array.from(right);
    unpainted[200] = EMPTY;
    expect(evaluateRule(rule, unpainted, ctx(unpainted)).status).toBe("pending");
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
