import { describe, expect, test } from "bun:test";
import { encodeGrid } from "../shared/codec";
import { isValidKey, LADDER_SIZE, ladderIndex } from "../shared/generate";
import { CELLS } from "../shared/palette";
import { bandFor, nextKey, solutionDigest } from "./runs";
import type { RunRow, RunSolveRow, Store } from "./store";

/**
 * The chained sequence is the one property that makes batch solving
 * unavailable rather than merely detected, and until now nothing tested it.
 *
 * `nextKey` reads exactly one thing from storage — the run's banked solves — so
 * the fake below is that method and nothing else. A full mock store would be
 * more code asserting less: every extra stubbed method is a chance to encode an
 * assumption the real store does not share.
 */
function storeWith(solves: RunSolveRow[]): Store {
  return {
    runSolves: async () => solves,
  } as unknown as Store;
}

const RUN: RunRow = {
  id: "run0123456789abc",
  secret: "5eba1b1a5eba1b1a5eba1b1a5eba1b1a",
  model: "test-model",
  provider: "test-provider",
  config: null,
  dialect: "0".repeat(32),
  created_at: 0,
  last_at: 0,
  status: "open",
  verified: 0,
};

/** A banked solve carrying a specific grid, which is all the chain reads. */
function solved(idx: number, fill: number): RunSolveRow {
  const g = new Int8Array(CELLS).fill(fill);
  return {
    id: idx, run_id: RUN.id, idx, puzzle_key: `L${idx + 1}`,
    points: 5, bonds: 0, difficulty: 20,
    wall_ms: 1000, api_calls: 1, probes: 1,
    tokens_in: null, tokens_out: null, cost_micro: null,
    art: encodeGrid(g as unknown as Int8Array), share_id: `s${idx}`, created_at: idx,
  } as RunSolveRow;
}

describe("the chained sequence", () => {
  test("rung zero is deterministic for a run", async () => {
    const a = await nextKey(storeWith([]), RUN, 0);
    const b = await nextKey(storeWith([]), RUN, 0);
    expect(a).toBe(b);
    expect(isValidKey(a)).toBe(true);
  });

  test("a different run secret gives a different first board", async () => {
    const other = { ...RUN, id: "run0123456789abd", secret: "f00dcafef00dcafef00dcafef00dcafe" };
    expect(await nextKey(storeWith([]), other, 0)).not.toBe(await nextKey(storeWith([]), RUN, 0));
  });

  /**
   * The property the whole design rests on. If two runs that solved rung 0
   * *differently* could still be handed the same rung 1, the chain would be
   * decoration: an attacker could precompute the sequence from the run secret
   * alone and go back to batching.
   */
  test("the next board depends on which grid was accepted", async () => {
    const one = await nextKey(storeWith([solved(0, 1)]), RUN, 1);
    const two = await nextKey(storeWith([solved(0, 2)]), RUN, 1);
    expect(one).not.toBe(two);
  });

  test("a key already banked by this run is never handed out twice", async () => {
    const first = await nextKey(storeWith([]), RUN, 0);
    // Bank precisely the key the chain wants to issue, and it must move on.
    const again = await nextKey(storeWith([{ ...solved(0, 1), puzzle_key: first }]), RUN, 0);
    expect(again).not.toBe(first);
    expect(isValidKey(again)).toBe(true);
  });

  test("every derived key is a real ladder key inside its band", async () => {
    for (let idx = 0; idx < 60; idx++) {
      const key = await nextKey(storeWith([]), RUN, idx);
      expect(isValidKey(key)).toBe(true);
      const n = ladderIndex(key)!;
      const { lo, hi } = bandFor(idx);
      expect(n).toBeGreaterThanOrEqual(lo);
      expect(n).toBeLessThanOrEqual(hi);
    }
  });
});

describe("the difficulty band", () => {
  test("opens on the generator's own easy tiers", () => {
    expect(bandFor(0)).toEqual({ lo: 1, hi: 3 });
    expect(bandFor(2).hi).toBeLessThanOrEqual(10);
  });

  test("widens monotonically and reaches the full ladder", () => {
    let prev = 0;
    for (let i = 0; i < 60; i++) {
      const { hi } = bandFor(i);
      expect(hi).toBeGreaterThanOrEqual(prev);
      prev = hi;
    }
    // The whole ladder is in range well before rung 60 — the band is a fraction
    // of `LADDER_SIZE`, so renumbering the ladder moves the curve with it
    // rather than stranding the top half in the opening tier.
    expect(bandFor(60).hi).toBe(LADDER_SIZE);
    expect(bandFor(24).hi).toBe(LADDER_SIZE);
    expect(bandFor(10).hi).toBeLessThan(LADDER_SIZE);
  });
});

describe("solutionDigest", () => {
  /**
   * `decodeGrid` accepts non-canonical encodings — `a1a1` and `a2` are the same
   * board — so digesting the string a client happened to send would let a solver
   * re-encode an accepted grid over and over, shopping for a next key it liked.
   * Canonicalising first is what closes that.
   */
  // A full board of one hue, and the same board described as two runs instead
  // of one. Built rather than written out, because a hand-typed base36 length
  // that is one cell short decodes to `null` and silently tests nothing.
  const full = encodeGrid(new Int8Array(CELLS).fill(0) as never);
  const split = `a1a${(CELLS - 1).toString(36).toUpperCase()}`;
  const otherHue = encodeGrid(new Int8Array(CELLS).fill(1) as never);

  test("digests the board, not the bytes that described it", async () => {
    expect(split).not.toBe(full);
    expect(await solutionDigest(0, split)).toBe(await solutionDigest(0, full));
  });

  test("a different board digests differently", async () => {
    expect(await solutionDigest(0, otherHue)).not.toBe(await solutionDigest(0, full));
  });

  test("the same board at a different rung digests differently", async () => {
    expect(await solutionDigest(1, full)).not.toBe(await solutionDigest(0, full));
  });
});
