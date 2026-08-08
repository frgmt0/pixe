import { beforeAll, describe, expect, test } from "bun:test";
import { encodeGrid } from "./codec";
import { assessPhase, dialectPhase } from "./dialect";
import { ladderKey, phaseCountFor, POINTS_MAX, POINTS_MIN } from "./generate";
import { CELLS, EMPTY, GRID, HUE_COUNT } from "./palette";
import { Rng } from "./prng";
import {
  buzzedHues, evaluateRule, makeCtx, ruleChannel, ruleText, type Grid,
} from "./rules";
import { zoneMap } from "./zones";

/**
 * The claim this file exists to prove.
 *
 * Phase k+1's laws are derived from the agent's accepted grid for phase k. That
 * is the whole point — a later phase cannot be attacked before an earlier one is
 * genuinely solved, because it does not exist yet. It is also the most dangerous
 * thing in the generator, because a derived constraint has no reason to be
 * satisfiable by a board drawn independently of it.
 *
 * `shared/phases.ts` answers that by never imposing a derived constraint: every
 * one is applied as an edit to phase k+1's reference solution before any law is
 * read off it. The consequence is that phase k+1 is solvable for **any** phase-k
 * grid whatsoever, not merely for the ones a well-behaved agent would send. So
 * the sweeps below feed it grids no agent would ever send — solid fills,
 * checkerboards, pseudorandom confetti — and assert that the reference solution
 * still validates clean every time.
 */

const SALTS = [
  "00112233445566778899aabbccddeeff",
  "f0e1d2c3b4a596876655443322110099",
  "9e3779b97f4a7c15f39cc0605cedc834",
];

/** Keys chosen to straddle both phase boundaries: two-phase and three-phase. */
const TWO_PHASE = [ladderKey(160), ladderKey(200), ladderKey(260), ladderKey(300)];
const THREE_PHASE = [ladderKey(320), ladderKey(370), ladderKey(430), ladderKey(499)];
const KEYS = [...TWO_PHASE, ...THREE_PHASE];

/** Grids a real agent would never send, which is exactly why they are here. */
function hostilePriors(seed: number): Grid[] {
  const rng = new Rng(seed);
  const solid = new Int8Array(CELLS);
  solid.fill(rng.int(HUE_COUNT));
  const checker = new Int8Array(CELLS);
  for (let i = 0; i < CELLS; i++) checker[i] = ((i % GRID) + ((i / GRID) | 0)) % 2 ? 1 : 6;
  const confetti = new Int8Array(CELLS);
  for (let i = 0; i < CELLS; i++) confetti[i] = rng.int(HUE_COUNT);
  const lopsided = new Int8Array(CELLS);
  for (let i = 0; i < CELLS; i++) lopsided[i] = i < CELLS - 40 ? 3 : 5;
  return [solid, checker, confetti, lopsided];
}

beforeAll(() => {
  for (const key of KEYS) for (const salt of SALTS) dialectPhase(salt, key, 1, []);
}, 300_000);

describe("the phase chain", () => {
  test("phase counts match the ladder position and the payload agrees", () => {
    for (const key of KEYS) {
      for (const salt of SALTS) {
        const { puzzle } = dialectPhase(salt, key, 1, []);
        expect(puzzle.phases).toBe(phaseCountFor(key));
        expect(puzzle.phase).toBe(1);
        expect(puzzle.locked).toEqual([]);
      }
    }
  });

  /**
   * Walking a rung the way an agent does: solve phase 1, hand that grid back,
   * take phase 2, and so on. Every phase's own reference solution has to
   * validate clean under that phase's laws.
   */
  test("every phase of every rung is solvable by its own reference solution", () => {
    for (const key of KEYS) {
      for (const salt of SALTS) {
        const priors: Grid[] = [];
        for (let phase = 1; phase <= phaseCountFor(key); phase++) {
          const { puzzle, target } = dialectPhase(salt, key, phase, priors);
          expect(puzzle.phase).toBe(phase);
          const a = assessPhase(salt, key, phase, priors, target);
          if (!a.solved) {
            const broken = puzzle.rules
              .map((r, i) => [r, a.evals[i]!] as const)
              .filter(([, e]) => e.status !== "ok")
              .map(([r, e]) => `${e.status} ${ruleText(r, puzzle.scheme)}`);
            throw new Error(`${key} @ ${salt} phase ${phase} unsolvable:\n  ${broken.join("\n  ")}`);
          }
          priors.push(Int8Array.from(target));
        }
      }
    }
  }, 300_000);

  /**
   * The stronger claim, and the one the construction actually buys: solvable
   * given *any* phase-k grid, not merely given the reference one. If this held
   * only for grids the generator itself produced, a run that found a different
   * legal answer to phase 1 — and different legal answers are the norm here,
   * boards have laws rather than a single solution — could be handed an
   * unwinnable phase 2.
   */
  test("a later phase is solvable whatever the earlier grid was", () => {
    for (const key of KEYS) {
      for (const salt of SALTS.slice(0, 2)) {
        for (const prior of hostilePriors(0xbeef)) {
          for (let phase = 2; phase <= phaseCountFor(key); phase++) {
            const priors = Array.from({ length: phase - 1 }, () => prior);
            const { puzzle, target } = dialectPhase(salt, key, phase, priors);
            const a = assessPhase(salt, key, phase, priors, target);
            if (!a.solved) {
              const broken = puzzle.rules
                .map((r, i) => [r, a.evals[i]!] as const)
                .filter(([, e]) => e.status !== "ok")
                .map(([r, e]) => `${e.status} ${ruleText(r, puzzle.scheme)}`);
              throw new Error(
                `${key} @ ${salt} phase ${phase} unsolvable from a hostile prior:\n  ${broken.join("\n  ")}`,
              );
            }
          }
        }
      }
    }
  }, 300_000);

  test("a later phase's reference solution honours every locked cell", () => {
    for (const key of KEYS) {
      for (const salt of SALTS) {
        const priors: Grid[] = [];
        for (let phase = 1; phase <= phaseCountFor(key); phase++) {
          const { puzzle, target } = dialectPhase(salt, key, phase, priors);
          if (phase > 1) expect(puzzle.locked.length).toBeGreaterThan(0);
          for (const c of puzzle.locked) {
            expect(target[c.y * GRID + c.x]).toBe(c.hue);
            expect(c.x).toBeGreaterThanOrEqual(0);
            expect(c.x).toBeLessThan(GRID);
            expect(c.y).toBeGreaterThanOrEqual(0);
            expect(c.y).toBeLessThan(GRID);
          }
          priors.push(Int8Array.from(target));
        }
      }
    }
  });

  test("a locked cell painted the wrong colour is refused, and it flashes", () => {
    for (const key of THREE_PHASE.slice(0, 2)) {
      for (const salt of SALTS.slice(0, 1)) {
        const first = dialectPhase(salt, key, 1, []).target;
        const priors = [Int8Array.from(first)];
        const { puzzle, target } = dialectPhase(salt, key, 2, priors);
        const locked = puzzle.locked[0]!;
        const g = Int8Array.from(target);
        const i = locked.y * GRID + locked.x;
        g[i] = (locked.hue + 1) % HUE_COUNT;
        const a = assessPhase(salt, key, 2, priors, g);
        expect(a.solved).toBe(false);
        expect(a.badCells.has(i)).toBe(true);
      }
    }
  });

  test("points stay inside the computed band on every phase", () => {
    for (const key of KEYS) {
      for (const salt of SALTS) {
        const priors: Grid[] = [];
        for (let phase = 1; phase <= phaseCountFor(key); phase++) {
          const { puzzle, target } = dialectPhase(salt, key, phase, priors);
          expect(puzzle.points).toBeGreaterThanOrEqual(POINTS_MIN);
          expect(puzzle.points).toBeLessThanOrEqual(POINTS_MAX);
          expect(puzzle.difficulty).toBeGreaterThan(0);
          priors.push(Int8Array.from(target));
        }
      }
    }
  });
});

describe("derivation", () => {
  /**
   * Determinism is the re-validation contract. The server keeps the seed and
   * the accepted grids and nothing else, so rebuilding a phase months later
   * must land on exactly the board the agent actually fought.
   */
  test("the same salt, key, phase and priors rebuild an identical board", () => {
    for (const key of THREE_PHASE) {
      for (const salt of SALTS) {
        const priors = [dialectPhase(salt, key, 1, []).target];
        const a = dialectPhase(salt, key, 2, priors);
        const b = dialectPhase(salt, key, 2, [Int8Array.from(priors[0]!)]);
        expect(encodeGrid(a.target)).toBe(encodeGrid(b.target));
        expect(JSON.stringify(a.puzzle.rules)).toBe(JSON.stringify(b.puzzle.rules));
      }
    }
  });

  /**
   * And the other half: the derivation has to actually depend on the grid. A
   * phase 2 that came out the same whatever was submitted would be a second
   * puzzle bolted on rather than a consequence of the first, and an agent could
   * work on it before finishing phase 1.
   */
  test("a different accepted grid yields a materially different next phase", () => {
    for (const key of THREE_PHASE) {
      const salt = SALTS[0]!;
      const boards = hostilePriors(0x1234).map((p) => dialectPhase(salt, key, 2, [p]));
      const grids = new Set(boards.map((b) => encodeGrid(b.target)));
      expect(grids.size).toBe(boards.length);
      const locks = new Set(boards.map((b) => JSON.stringify(b.puzzle.locked)));
      expect(locks.size).toBeGreaterThan(1);
    }
  });

  /**
   * The silence rule and the channel contract, on phase boards specifically.
   * A later phase carries laws the base generator never produces — the derived
   * quotas and the locked cells — so the invariant is re-checked where those
   * live rather than assumed to carry over from `engine.test.ts`.
   */
  test("no phase law is ever broken and invisible, or pending on a full grid", () => {
    for (const key of KEYS) {
      for (const salt of SALTS.slice(0, 2)) {
        const priors: Grid[] = [];
        for (let phase = 1; phase <= phaseCountFor(key); phase++) {
          const { puzzle, target } = dialectPhase(salt, key, phase, priors);
          const zmap = zoneMap(puzzle.scheme);

          const probes: Grid[] = [];
          const blank = new Int8Array(CELLS);
          blank.fill(EMPTY);
          probes.push(blank);
          for (const h of puzzle.hueSet.slice(0, 3)) {
            const solid = new Int8Array(CELLS);
            solid.fill(h);
            probes.push(solid);
          }
          for (const frac of [0.25, 0.75]) {
            const g = Int8Array.from(target);
            g.fill(puzzle.hueSet[0]!, 0, Math.floor(CELLS * frac));
            probes.push(g);
          }
          const holed = Int8Array.from(target);
          holed.fill(EMPTY, 1000, 1400);
          probes.push(holed);

          for (const g of probes) {
            const ctx = makeCtx(g, zmap);
            const full = !g.includes(EMPTY);
            for (const rule of puzzle.rules) {
              const ev = evaluateRule(rule, g, ctx);
              if (ev.status === "ok") continue;
              if (ev.status === "pending") {
                // Unmet but reachable is a legitimate silence only while there
                // is still somewhere to put the missing paint.
                expect(full).toBe(false);
                expect(ev.violations.length).toBe(0);
                continue;
              }
              const channel = ruleChannel(rule);
              const flashes = ev.violations.length;
              const buzzes = buzzedHues(ev).length;
              const visible =
                channel === "cell" ? flashes > 0 : channel === "swatch" ? buzzes > 0 : flashes + buzzes > 0;
              if (!visible) {
                throw new Error(
                  `${key} @ ${salt} phase ${phase}: ${channel}-channel law with no feedback: ` +
                    ruleText(rule, puzzle.scheme),
                );
              }
            }
          }
          priors.push(Int8Array.from(target));
        }
      }
    }
  }, 300_000);

  /** A phase is a whole board, not a variation: new geometry every time. */
  test("later phases draw their own zone scheme", () => {
    let differed = 0;
    let compared = 0;
    for (const key of THREE_PHASE) {
      for (const salt of SALTS) {
        const priors: Grid[] = [dialectPhase(salt, key, 1, []).target];
        const one = dialectPhase(salt, key, 1, []).puzzle.scheme;
        const two = dialectPhase(salt, key, 2, priors).puzzle.scheme;
        compared++;
        if (JSON.stringify(one) !== JSON.stringify(two)) differed++;
      }
    }
    // Schemes are drawn at random, so a collision is possible; most must move.
    expect(differed / compared).toBeGreaterThan(0.6);
  });
});
