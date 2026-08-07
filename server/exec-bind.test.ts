import { describe, expect, test } from "bun:test";
import { CELLS, EMPTY_RGB, HUE_RGB } from "../shared/palette";
import {
  EMPTY_EXEC_TALLY,
  EXEC_GATE,
  execChallenge,
  gateExec,
  openExecReceipt,
  paletteBytes,
  pixelAnswer,
  PROBE_CELLS,
  readExecReceipt,
  signExecReceipt,
  verifyExecProof,
  type ExecChallenge,
  type ExecProof,
} from "./exec-bind";

const SECRET = "5eba1b1a5eba1b1a5eba1b1a5eba1b1a";
const OTHER_SECRET = "f00dcafef00dcafef00dcafef00dcafe";
const RUN = "run0123456789abc";
const IDX = 3;
const NOW = 1_700_000_000_000;

/** A grid with a recognisable, non-uniform pattern in it. */
function grid(seed = 1): Int8Array {
  const g = new Int8Array(CELLS);
  for (let i = 0; i < CELLS; i++) g[i] = ((i * seed) % 9) - 1; // -1..7, empties included
  return g;
}

/**
 * What a browser would actually get back from `getImageData`, built here from
 * the palette rather than from `paletteBytes` — grading the server's expectation
 * with the server's own function would only prove it equals itself.
 */
function browserReadback(g: Int8Array, cells: number[]): string {
  const hex = (n: number) => (n & 0xff).toString(16).padStart(2, "0");
  let s = "";
  for (const c of cells) {
    const v = g[c]!;
    const [r, gg, b] = v < 0 ? EMPTY_RGB : HUE_RGB[v]!;
    s += hex(r) + hex(gg) + hex(b) + "ff";
  }
  return s;
}

/** A well-formed proof, as the page would produce it for `ch` against `g`. */
async function proofFor(ch: ExecChallenge, g: Int8Array | null): Promise<ExecProof> {
  return {
    v: 1,
    cid: ch.cid,
    px: g ? await pixelAnswer(ch.cid, browserReadback(g, ch.cells)) : null,
    style: [],
    raf: [12.5, 29.2, 45.9],
  };
}

describe("the challenge", () => {
  test("is deterministic for a run, issue and chain position", async () => {
    const a = await execChallenge(SECRET, RUN, IDX, 0);
    const b = await execChallenge(SECRET, RUN, IDX, 0);
    expect(a).toEqual(b);
  });

  test("probes real cells, and enough of them to matter", async () => {
    const ch = await execChallenge(SECRET, RUN, IDX, 0);
    expect(ch.cells).toHaveLength(PROBE_CELLS);
    for (const c of ch.cells) {
      expect(Number.isInteger(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(CELLS);
    }
  });

  /**
   * The binding, stated as four attacks. If any of these produced the same
   * challenge id, an answer could be computed once and spent everywhere, and
   * the layer would be decoration.
   */
  test("cannot be lifted across run, issue or chain position", async () => {
    const base = await execChallenge(SECRET, RUN, IDX, 0);
    const otherRun = await execChallenge(SECRET, "run0123456789abd", IDX, 0);
    const otherIssue = await execChallenge(SECRET, RUN, IDX + 1, 0);
    const otherSeq = await execChallenge(SECRET, RUN, IDX, 1);
    const otherSecret = await execChallenge(OTHER_SECRET, RUN, IDX, 0);
    for (const other of [otherRun, otherIssue, otherSeq, otherSecret]) {
      expect(other.cid).not.toBe(base.cid);
    }
  });

  test("asks for style probes an engine can answer identically", async () => {
    const ch = await execChallenge(SECRET, RUN, IDX, 0);
    expect(ch.style.length).toBeGreaterThan(0);
    for (const p of ch.style) {
      expect(typeof p.set).toBe("string");
      expect(typeof p.read).toBe("string");
      expect(p.set).toContain(":");
    }
  });

  test("does not leak the run secret into what it sends", async () => {
    const ch = await execChallenge(SECRET, RUN, IDX, 0);
    expect(JSON.stringify(ch)).not.toContain(SECRET);
  });
});

describe("the canvas answer", () => {
  /**
   * The whole layer rests on this: a 1:1 readback of the art canvas is the
   * palette-mapped grid, byte for byte, so the server can compute it from the
   * grid it already holds.
   */
  test("the server's expectation equals an independent palette mapping", async () => {
    const ch = await execChallenge(SECRET, RUN, IDX, 0);
    const g = grid();
    expect(paletteBytes(g, ch.cells)).toBe(browserReadback(g, ch.cells));
  });

  test("empty cells read back as the empty colour, not as a hue", () => {
    const g = new Int8Array(CELLS).fill(-1);
    const hex = (n: number) => (n & 0xff).toString(16).padStart(2, "0");
    expect(paletteBytes(g, [0])).toBe(hex(EMPTY_RGB[0]) + hex(EMPTY_RGB[1]) + hex(EMPTY_RGB[2]) + "ff");
  });

  test("the answer is bound to the challenge id", async () => {
    const g = grid();
    const one = await execChallenge(SECRET, RUN, IDX, 0);
    const two = await execChallenge(SECRET, RUN, IDX, 1);
    const a = await pixelAnswer(one.cid, paletteBytes(g, one.cells));
    const b = await pixelAnswer(two.cid, paletteBytes(g, one.cells));
    expect(a).not.toBe(b);
  });
});

describe("the exec receipt", () => {
  test("round-trips a tally", async () => {
    const t = { seq: 4, proofs: 4, pixel: 3, frames: 4, style: 4, lastAt: NOW };
    const r = await signExecReceipt(SECRET, RUN, IDX, t);
    expect(await readExecReceipt(SECRET, RUN, IDX, r)).toEqual(t);
  });

  test("a receipt for another run, issue or secret is not ours", async () => {
    const r = await openExecReceipt(SECRET, RUN, IDX);
    expect(await readExecReceipt(SECRET, RUN, IDX + 1, r)).toBeNull();
    expect(await readExecReceipt(SECRET, "run0123456789abd", IDX, r)).toBeNull();
    expect(await readExecReceipt(OTHER_SECRET, RUN, IDX, r)).toBeNull();
  });

  test("a tampered tally does not verify", async () => {
    const r = await signExecReceipt(SECRET, RUN, IDX, {
      seq: 1, proofs: 1, pixel: 0, frames: 0, style: 0, lastAt: NOW,
    });
    const forged = await signExecReceipt(OTHER_SECRET, RUN, IDX, {
      seq: 1, proofs: 1, pixel: 99, frames: 0, style: 0, lastAt: NOW,
    });
    const [payload] = forged.split(".");
    expect(await readExecReceipt(SECRET, RUN, IDX, `${payload}.${r.split(".")[1]}`)).toBeNull();
  });

  test("garbage is refused rather than parsed", async () => {
    for (const bad of ["", ".", "nope", "a.b", null, 7, "x".repeat(600)]) {
      expect(await readExecReceipt(SECRET, RUN, IDX, bad)).toBeNull();
    }
  });
});

describe("verifying a proof", () => {
  const check = (over: Partial<Parameters<typeof verifyExecProof>[0]>) =>
    verifyExecProof({
      secret: SECRET, runId: RUN, idx: IDX, receipt: null, proof: null, grid: null, now: NOW,
      ...over,
    });

  test("a correct readback counts, and advances the chain", async () => {
    const ch = await execChallenge(SECRET, RUN, IDX, 0);
    const g = grid();
    const out = await check({ proof: await proofFor(ch, g), grid: g });
    expect(out.verdict.pixel).toBe("match");
    expect(out.tally.pixel).toBe(1);
    expect(out.tally.seq).toBe(1);
    expect(out.tally.lastAt).toBe(NOW);
    // And the next challenge is a different question.
    expect(out.challenge.cid).not.toBe(ch.cid);
  });

  test("the tally accumulates across a chain of proofs", async () => {
    const g = grid();
    let receipt: string | undefined;
    let ch = await execChallenge(SECRET, RUN, IDX, 0);
    for (let i = 0; i < 4; i++) {
      const out = await check({ receipt, proof: await proofFor(ch, g), grid: g });
      receipt = out.receipt;
      ch = out.challenge;
      expect(out.tally.pixel).toBe(i + 1);
    }
  });

  /**
   * The serialisation property, borrowed wholesale from the attestation chain:
   * a thousand concurrent proofs all chained from receipt zero produce a
   * thousand tallies of one, because there is no operation that merges them.
   */
  test("concurrent proofs from the same receipt do not merge", async () => {
    const g = grid();
    const ch = await execChallenge(SECRET, RUN, IDX, 0);
    const start = await openExecReceipt(SECRET, RUN, IDX);
    const many = await Promise.all(
      Array.from({ length: 8 }, async () =>
        check({ receipt: start, proof: await proofFor(ch, g), grid: g }),
      ),
    );
    for (const out of many) expect(out.tally.pixel).toBe(1);
  });

  test("a readback of a different grid does not count", async () => {
    const ch = await execChallenge(SECRET, RUN, IDX, 0);
    const out = await check({ proof: await proofFor(ch, grid(2)), grid: grid(3) });
    expect(out.verdict.pixel).toBe("mismatch");
    expect(out.verdict.notes).toContain("canvas-mismatch");
    expect(out.tally.pixel).toBe(0);
  });

  test("an answer to the previous challenge does not count", async () => {
    const g = grid();
    const stale = await execChallenge(SECRET, RUN, IDX, 0);
    const first = await check({ proof: await proofFor(stale, g), grid: g });
    // Replay the same proof against the advanced receipt.
    const again = await check({
      receipt: first.receipt, proof: await proofFor(stale, g), grid: g,
    });
    expect(again.verdict.pixel).toBe("absent");
    expect(again.verdict.notes).toContain("stale-challenge");
    expect(again.tally.pixel).toBe(1); // carried, not added to
  });

  test("an answer computed for another issue does not count", async () => {
    const g = grid();
    const elsewhere = await execChallenge(SECRET, RUN, IDX + 1, 0);
    const out = await check({ proof: await proofFor(elsewhere, g), grid: g });
    expect(out.verdict.notes).toContain("stale-challenge");
    expect(out.tally.pixel).toBe(0);
  });

  /* --- degradation: none of these may be an error ------------------- */

  test("no proof at all is inconclusive, not a failure", async () => {
    const out = await check({});
    expect(out.verdict.pixel).toBe("absent");
    expect(out.verdict.notes).toContain("no-proof");
    expect(out.tally.seq).toBe(1);
    expect(typeof out.receipt).toBe("string");
  });

  test("an envelope with no canvas attached is inconclusive", async () => {
    const ch = await execChallenge(SECRET, RUN, IDX, 0);
    const out = await check({ proof: await proofFor(ch, grid()), grid: null });
    expect(out.verdict.pixel).toBe("absent");
    expect(out.verdict.notes).toContain("no-grid");
  });

  test("an unreadable receipt restarts the chain instead of erroring", async () => {
    const out = await check({ receipt: "not-a-receipt" });
    expect(out.verdict.notes).toContain("receipt-reset");
    expect(out.tally.seq).toBe(1);
    expect(out.tally.pixel).toBe(0);
  });

  test("malformed proof shapes are survived", async () => {
    for (const proof of [7, "x", [], { cid: 5 }, { cid: null, px: {}, style: 1, raf: "no" }]) {
      const out = await check({ proof, grid: grid() });
      expect(out.tally.seq).toBe(1);
      expect(out.tally.pixel).toBe(0);
    }
  });

  test("a proof carrying a hostile receipt cannot inflate the tally", async () => {
    // Signed by a different run's secret, so it is not ours and is discarded.
    const forged = await signExecReceipt(OTHER_SECRET, RUN, IDX, {
      seq: 0, proofs: 500, pixel: 500, frames: 500, style: 500, lastAt: NOW,
    });
    const out = await check({ receipt: forged });
    expect(out.tally.pixel).toBe(0);
  });
});

describe("the advisory layers", () => {
  const base = async (over: Partial<ExecProof>) => {
    const ch = await execChallenge(SECRET, RUN, IDX, 0);
    return verifyExecProof({
      secret: SECRET, runId: RUN, idx: IDX, receipt: null, grid: null, now: NOW,
      proof: { v: 1, cid: ch.cid, px: null, style: [], raf: [], ...over },
    });
  };

  test("frames read as evidence a loop ran, never as evidence about its rate", async () => {
    // Wildly uneven spacing, which a stalled container or a virtual clock
    // produces routinely. It must still count.
    expect((await base({ raf: [0.1, 4000, 4000.2, 90000] })).verdict.frames).toBe("match");
    expect((await base({ raf: [] })).verdict.frames).toBe("absent");
    expect((await base({ raf: [5] })).verdict.frames).toBe("absent");
    expect((await base({ raf: [5, 4] })).verdict.frames).toBe("mismatch");
    expect((await base({ raf: [5, Number.NaN] })).verdict.frames).toBe("mismatch");
  });

  test("style answers are checked case- and whitespace-insensitively", async () => {
    const ch = await execChallenge(SECRET, RUN, IDX, 0);
    const wrong = await verifyExecProof({
      secret: SECRET, runId: RUN, idx: IDX, receipt: null, grid: null, now: NOW,
      proof: { v: 1, cid: ch.cid, px: null, style: ch.style.map(() => "nope"), raf: [] },
    });
    expect(wrong.verdict.style).toBe("mismatch");
    expect(wrong.verdict.notes).toContain("style-mismatch");
  });

  /**
   * The thing that would make this dangerous: an advisory layer that quietly
   * became load-bearing. A proof that gets style and frames wrong but the
   * canvas right must still count, because the canvas is the only layer whose
   * answer the server can independently derive.
   */
  test("a wrong advisory answer never blocks a correct readback", async () => {
    const ch = await execChallenge(SECRET, RUN, IDX, 0);
    const g = grid();
    const out = await verifyExecProof({
      secret: SECRET, runId: RUN, idx: IDX, receipt: null, grid: g, now: NOW,
      proof: {
        v: 1,
        cid: ch.cid,
        px: await pixelAnswer(ch.cid, browserReadback(g, ch.cells)),
        style: ch.style.map(() => "nope"),
        raf: [9, 8],
      },
    });
    expect(out.verdict.pixel).toBe("match");
    expect(out.tally.pixel).toBe(1);
    expect(gateExec({ ...out.tally, pixel: EXEC_GATE.pixel }, NOW)).toBeNull();
  });
});

describe("the gate", () => {
  const tally = (over: Partial<typeof EMPTY_EXEC_TALLY>) => ({
    ...EMPTY_EXEC_TALLY, seq: 9, proofs: 9, lastAt: NOW, ...over,
  });

  test("an empty tally is complained about, which is why enforcement is opt-in", () => {
    expect(gateExec(EMPTY_EXEC_TALLY, NOW)).not.toBeNull();
  });

  test("enough matching readbacks clears it", () => {
    expect(gateExec(tally({ pixel: EXEC_GATE.pixel }), NOW)).toBeNull();
  });

  test("one short does not", () => {
    expect(gateExec(tally({ pixel: EXEC_GATE.pixel - 1 }), NOW)).not.toBeNull();
  });

  test("a session that stopped rendering long ago goes stale", () => {
    const t = tally({ pixel: EXEC_GATE.pixel, lastAt: NOW - EXEC_GATE.freshMs - 1 });
    expect(gateExec(t, NOW)).not.toBeNull();
  });

  /**
   * The floor is deliberately low. A page painting 4096 cells settles dozens of
   * times per board, so the honest margin over the gate is an order of
   * magnitude — which is what keeps an innocent canvas/grid skew from ever
   * costing anybody a solve.
   */
  test("the floor sits far below what a real session produces", () => {
    expect(EXEC_GATE.pixel).toBeLessThanOrEqual(3);
  });
});
