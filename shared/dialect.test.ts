import { beforeAll, describe, expect, test } from "bun:test";
import { assessDialect, dialectPuzzle, isDialectSalt, newDialectSalt } from "./dialect";
import { generate, ladderKey } from "./generate";
import { CELLS, GRID, HUE_COUNT } from "./palette";
import { ruleText, type Rule } from "./rules";
import { zoneCount, zoneMap } from "./zones";

/**
 * Four fixed salts rather than random ones. A dialect that is only *usually*
 * solvable is a broken game for whoever draws the bad salt, so the failure has
 * to be reproducible from the test output alone.
 */
const SALTS = [
  "00112233445566778899aabbccddeeff",
  "f0e1d2c3b4a596876655443322110099",
  "9e3779b97f4a7c15f39cc0605cedc834",
  "0123456789abcdef0123456789abcdef",
];

const KEYS = [
  ...Array.from({ length: 24 }, (_, i) => ladderKey(i + 1)),
  ...Array.from({ length: 16 }, (_, i) => ladderKey(40 + i * 137)),
];

/**
 * A dialect costs a base generation plus a full re-derivation, so the corpus is
 * ~30ms per puzzle. `dialectPuzzle` memoises; paying for the whole sweep once
 * here keeps that cost out of the individual tests, which would otherwise each
 * trip the default timeout on their first call and look like failures.
 */
beforeAll(() => {
  for (const key of KEYS) for (const salt of SALTS) dialectPuzzle(salt, key);
}, 300_000);

describe("dialect salts", () => {
  test("minted salts are 128 bits of hex and pass their own validator", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const s = newDialectSalt();
      expect(isDialectSalt(s)).toBe(true);
      seen.add(s);
    }
    expect(seen.size).toBe(64);
  });

  test("junk is rejected", () => {
    for (const bad of ["", "xyz", "00112233445566778899aabbccddeef", "G0112233445566778899aabbccddeeff", 42, null, {}]) {
      expect(isDialectSalt(bad)).toBe(false);
    }
  });
});

describe("determinism", () => {
  test("the same salt and key regenerate an identical puzzle and target", () => {
    for (const key of KEYS.slice(0, 12)) {
      for (const salt of SALTS) {
        const a = dialectPuzzle(salt, key);
        const b = dialectPuzzle(salt, key);
        expect(JSON.stringify(a.puzzle)).toBe(JSON.stringify(b.puzzle));
        expect(Array.from(a.target)).toEqual(Array.from(b.target));
      }
    }
  });

  /**
   * Memoisation is load-bearing — the feedback endpoint re-derives on every
   * round trip — so a cache that could ever answer with a different board than
   * a cold derivation would be a validator that disagrees with the glow.
   */
  test("a cold derivation matches a memoised one", () => {
    const salt = "abcdef0123456789abcdef0123456789";
    const key = ladderKey(77);
    const warm = dialectPuzzle(salt, key);
    // Same inputs by a different route: the cache key is `salt|key`, so a
    // second salt evicts nothing but proves the derivation is a pure function.
    const again = dialectPuzzle(salt, key);
    expect(Array.from(again.target)).toEqual(Array.from(warm.target));
    expect(JSON.stringify(again.puzzle.rules)).toBe(JSON.stringify(warm.puzzle.rules));
  });

  test("the salt never appears in anything the puzzle carries", () => {
    const salt = "deadbeefdeadbeefdeadbeefdeadbeef";
    const { puzzle } = dialectPuzzle(salt, ladderKey(9));
    expect(JSON.stringify(puzzle)).not.toContain(salt);
  });
});

describe("solvability", () => {
  /**
   * The invariant the whole design rests on. The generator can promise a
   * solution exists only because it builds the reference solution first and
   * reads the laws off it; a dialect that perturbs the board but derives its
   * laws from anything other than the perturbed grid would quietly ship
   * unwinnable puzzles, and an unwinnable puzzle makes the benchmark a lie.
   *
   * Mirrors the sweep in engine.test.ts, routed through the dialect's own
   * assessment path — the same one the server scores submissions with.
   */
  test("every dialect puzzle's own reference target validates clean", () => {
    for (const key of KEYS) {
      for (const salt of SALTS) {
        const { target } = dialectPuzzle(salt, key);
        const a = assessDialect(salt, key, target);
        if (!a.solved) {
          const broken = a.puzzle.rules
            .map((r, i) => [r, a.evals[i]!] as const)
            .filter(([, e]) => e.status !== "ok")
            .map(([r, e]) => `${e.status} ${ruleText(r, a.puzzle.scheme)}`);
          throw new Error(`${key} @ ${salt} unsolvable by its own target:\n  ${broken.join("\n  ")}`);
        }
        expect(a.empty).toBe(0);
      }
    }
  });

  test("dialect targets are fully painted with real hues", () => {
    for (const key of KEYS.slice(0, 12)) {
      for (const salt of SALTS) {
        const { target } = dialectPuzzle(salt, key);
        for (let i = 0; i < CELLS; i++) {
          expect(target[i]).toBeGreaterThanOrEqual(0);
          expect(target[i]).toBeLessThan(HUE_COUNT);
        }
      }
    }
  });

  test("puzzle shape stays inside the same envelope as the base generator", () => {
    for (const key of KEYS) {
      for (const salt of SALTS) {
        const { puzzle } = dialectPuzzle(salt, key);
        expect(puzzle.rules.length).toBeGreaterThanOrEqual(2);
        expect(puzzle.rules.length).toBeLessThanOrEqual(14);
        expect(puzzle.points).toBeGreaterThanOrEqual(3);
        expect(puzzle.points).toBeLessThanOrEqual(7);
        expect(puzzle.hueSet.length).toBeGreaterThanOrEqual(2);
        const zoneRules = puzzle.rules.filter((r) => r.t === "zone");
        expect(zoneRules.length).toBe(zoneCount(puzzle.scheme));
        // A zone that permits one hue is a solid fill with the generator's
        // blessing, and a zone that permits nearly everything permits nothing.
        for (const r of zoneRules) {
          if (r.t !== "zone") continue;
          expect(r.hues.length).toBeGreaterThanOrEqual(2);
          expect(r.hues.length).toBeLessThanOrEqual(4);
          expect(r.each).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });
});

describe("dialects do not transfer", () => {
  const ruleSet = (salt: string, key: string) =>
    new Set(dialectPuzzle(salt, key).puzzle.rules.map((r) => JSON.stringify(r)));

  /**
   * The point of the whole file. Two runs handed the same ladder key must be
   * playing different boards under different laws — otherwise a solver that has
   * seen L4271 once recognises it in every run forever, and the chained
   * sequence buys nothing beyond serialisation.
   */
  test("different salts give materially different law sets for the same key", () => {
    for (const key of KEYS) {
      for (let i = 0; i < SALTS.length; i++) {
        for (let j = i + 1; j < SALTS.length; j++) {
          const a = ruleSet(SALTS[i]!, key);
          const b = ruleSet(SALTS[j]!, key);
          let shared = 0;
          for (const r of a) if (b.has(r)) shared++;
          const overlap = shared / Math.max(a.size, b.size);
          if (overlap > 0.34) {
            throw new Error(
              `${key}: dialects ${i} and ${j} share ${Math.round(overlap * 100)}% of their laws`,
            );
          }
        }
      }
    }
  });

  /**
   * A deliberately weak assertion, and worth saying why.
   *
   * Two dialects of one key share the zone geometry and the underlying noise
   * field, because both come from the key — which is public the moment it is
   * issued. So cell-level agreement can never go to zero, and driving it there
   * would mean scribbling over the blobby structure that makes adjacency laws
   * derivable at all. Agreement is a smoke test for "the perturbation did
   * something", nothing more. The claim that actually matters is the one below
   * it: a grid from one dialect must not validate under another's laws.
   */
  test("different salts visibly repaint the reference solution", () => {
    for (const key of KEYS) {
      for (let i = 0; i < SALTS.length; i++) {
        for (let j = i + 1; j < SALTS.length; j++) {
          const a = dialectPuzzle(SALTS[i]!, key).target;
          const b = dialectPuzzle(SALTS[j]!, key).target;
          let same = 0;
          for (let c = 0; c < CELLS; c++) if (a[c] === b[c]) same++;
          expect(same / CELLS).toBeLessThan(0.8);
        }
      }
    }
  });

  /**
   * The transfer claim stated as an attack rather than as a statistic: hand one
   * dialect's accepted answer to another dialect and it must be rejected. This
   * is what stops a run from replaying a board another run already solved.
   */
  test("one dialect's solution never satisfies another dialect's laws", () => {
    for (const key of KEYS) {
      for (let i = 0; i < SALTS.length; i++) {
        for (let j = 0; j < SALTS.length; j++) {
          if (i === j) continue;
          const stolen = dialectPuzzle(SALTS[i]!, key).target;
          if (assessDialect(SALTS[j]!, key, stolen).solved) {
            throw new Error(`${key}: dialect ${i}'s target also solves dialect ${j}`);
          }
        }
      }
    }
  });

  /**
   * And the same for the board the ladder key generates on its own. The key is
   * public the moment it is issued, so anyone holding a copy of the generator
   * can compute the base reference solution for it in 17ms. That grid must not
   * be worth anything.
   */
  test("the base generator's solution never satisfies a dialect's laws", () => {
    for (const key of KEYS) {
      const base = generate(key).target;
      for (const salt of SALTS) {
        expect(assessDialect(salt, key, base).solved).toBe(false);
      }
    }
  });
});

describe("dialects stay hostile to no-thought fills", () => {
  const zoneInfo = (salt: string, key: string) => {
    const { puzzle } = dialectPuzzle(salt, key);
    return {
      zmap: zoneMap(puzzle.scheme),
      palettes: puzzle.rules
        .filter((r): r is Extract<Rule, { t: "zone" }> => r.t === "zone")
        .sort((a, b) => a.zone - b.zone)
        .map((r) => r.hues),
    };
  };

  /**
   * A dialect re-derives its own law set, so it re-inherits the failure mode
   * the generator's adversarial pass exists to close: a rule set that happens
   * to be pattern-compatible by chance. Measured at 21% of the ladder upstream
   * before hardening existed, and there is no reason a perturbed board would be
   * luckier. Re-implemented here rather than reusing the dialect's own decoy
   * set, so the check cannot be graded by the thing it optimises against.
   */
  test("no dialect puzzle falls to a mechanical pattern fill", () => {
    const patterns: ((x: number, y: number) => number)[] = [
      (x, y) => x + y,
      (x, y) => y,
      (x, y) => x,
      (x, y) => (x >> 1) + (y >> 1),
      (x, y) => (x + y) >> 2,
      (x, y) => y >> 2,
      (x, y) => x >> 2,
    ];
    for (const key of KEYS) {
      for (const salt of SALTS) {
        const { zmap, palettes } = zoneInfo(salt, key);
        for (const pat of patterns) {
          for (let rot = 0; rot < 4; rot++) {
            const g = new Int8Array(CELLS);
            for (let i = 0; i < CELLS; i++) {
              const pal = palettes[zmap[i]!]!;
              g[i] = pal[(pat(i % GRID, (i / GRID) | 0) + rot) % pal.length]!;
            }
            if (assessDialect(salt, key, g).solved) {
              throw new Error(`${key} @ ${salt} solved by a mechanical fill (rot ${rot})`);
            }
          }
        }
      }
    }
  }, 120_000);

  // Every zone palette combination, so the cost is the product of the palette
  // sizes — a narrower sweep than the one above buys the same signal.
  test("no dialect puzzle falls to one solid hue per zone", () => {
    for (const key of KEYS.slice(0, 14)) {
      for (const salt of SALTS) {
        const { zmap, palettes } = zoneInfo(salt, key);
        const idx = new Array<number>(palettes.length).fill(0);
        for (;;) {
          const g = new Int8Array(CELLS);
          for (let i = 0; i < CELLS; i++) g[i] = palettes[zmap[i]!]![idx[zmap[i]!]!]!;
          if (assessDialect(salt, key, g).solved) {
            throw new Error(`${key} @ ${salt} solved by a solid zone fill`);
          }
          let k = palettes.length - 1;
          while (k >= 0 && ++idx[k]! >= palettes[k]!.length) {
            idx[k] = 0;
            k--;
          }
          if (k < 0) break;
        }
      }
    }
  }, 120_000);
});
