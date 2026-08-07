/**
 * What these tests are actually asserting.
 *
 * The interesting property in `attest.ts` is arithmetic, not plausibility: the
 * write ledger carried by the events, replayed onto the canvas in the receipt,
 * must produce the grid the client is asking about — and at submit, the grid it
 * is banking. So most of what follows is "break the ledger in one specific way
 * and watch the envelope stop verifying".
 *
 * There is deliberately NO test that a stream "looks human". The intended
 * players drive the page with Playwright or Puppeteer, headless included, and
 * every timing- or coordinate-realism heuristic fires hardest on exactly them.
 * The last test in this file makes the residual explicit instead: a script that
 * decomposes its answer into legal strokes passes, on purpose, and that is what
 * this layer is worth.
 */

import { describe, expect, test } from "bun:test";
import { decodeGrid, encodeGrid } from "../shared/codec";
import { CELLS, EMPTY, GRID } from "../shared/palette";
import { emptyGrid } from "../shared/rules";
import {
  ENVELOPE_VERSION,
  EMPTY_TALLY,
  encodeWrites,
  gateSubmit,
  nonceFor,
  openReceipt,
  parseWrites,
  bindReceipt,
  signReceipt,
  verifyAttest,
  type AttestedEvent,
} from "./attest";

const SECRET = "test-secret-not-a-real-run-secret";
const RUN = "run_abc123";
const IDX = 3;

/* ------------------------------------------------------------------ */
/* A real captured session                                             */
/* ------------------------------------------------------------------ */

/**
 * Captured from a headless Chromium driven by Playwright against the dev server
 * on 2026-08-06: register a run, pair it, take rung 0, then paint six bands
 * with `page.mouse.down/move/up` and pick hues with the number keys. Every one
 * of the 32 `/api/attest` calls in that session answered 200; these are the
 * first twelve envelopes verbatim, with `at` rebased to offsets from the first
 * event and the run-signed `receipt`/`nonce` dropped, since those belong to a
 * secret this file does not have.
 *
 * This is the fixture that matters. If a change here stops it verifying, the
 * change breaks real play — which is the failure mode worth catching, because
 * it is the one nobody notices until an entrant complains.
 */
interface Envelope {
  events: AttestedEvent[];
  art?: string;
}

const CAPTURED: Envelope[] = [
  { events: [{ t: "pick", at: 0 }] },
  {
    events: [{ t: "stroke", at: 357, n: 248, d: 252, w: "a1-1Qa2-1Qa2-1Qa2-1Q" }],
    art:
      "i1a1Qi2a1Qi2a1Qi2a1Qi2YP",
  },
  {
    events: [{ t: "stroke", at: 750, n: 124, d: 241, w: "a75-1Qa2-1Q" }],
    art:
      "i1a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2V5",
  },
  {
    events: [{ t: "stroke", at: 1182, n: 124, d: 292, w: "aAP-1Qa2-1Q" }],
    art:
      "i1a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2RL",
  },
  {
    events: [{ t: "stroke", at: 1614, n: 124, d: 290, w: "aE9-1Qa2-1Q" }],
    art:
      "i1a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2O1",
  },
  { events: [{ t: "pick", at: 2070 }] },
  {
    events: [{ t: "stroke", at: 2467, n: 248, d: 276, w: "bHT-1Qb2-1Qb2-1Qb2-1Q" }],
    art:
      "i1a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2b1Qi2b1Qi2b1Qi2b1Qi2GX",
  },
  {
    events: [{ t: "stroke", at: 2880, n: 124, d: 272, w: "bOX-1Qb2-1Q" }],
    art:
      "i1a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2b1Qi2b1Qi2b1Qi2b1Qi2b1Qi2b1Q" +
      "i2DD",
  },
  {
    events: [{ t: "stroke", at: 3352, n: 124, d: 327, w: "bSH-1Qb2-1Q" }],
    art:
      "i1a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2b1Qi2b1Qi2b1Qi2b1Qi2b1Qi2b1Q" +
      "i2b1Qi2b1Qi29T",
  },
  {
    events: [{ t: "stroke", at: 3796, n: 124, d: 291, w: "bW1-1Qb2-1Q" }],
    art:
      "i1a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2b1Qi2b1Qi2b1Qi2b1Qi2b1Qi2b1Q" +
      "i2b1Qi2b1Qi2b1Qi2b1Qi269",
  },
  { events: [{ t: "pick", at: 4249 }] },
  {
    events: [{ t: "stroke", at: 4706, n: 248, d: 350, w: "cZL-1Qc2-1Qc2-1Qc2-1Q" }],
    art:
      "i1a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2a1Qi2b1Qi2b1Qi2b1Qi2b1Qi2b1Qi2b1Q" +
      "i2b1Qi2b1Qi2b1Qi2b1Qi2c1Qi2c1Qi2c1Qi2c1Qi1Z5",
  },
];

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

interface Chained {
  receipt: string;
  nonce: string;
  seq: number;
  events: number;
  strokes: number;
  intents: number;
  writes: number;
  filled: number;
  grid: Int8Array;
}

/** Push one envelope through `verifyAttest`, carrying the chain forward. */
async function push(
  prev: { receipt: string; nonce: string },
  env: Envelope,
  now: number,
  base: number,
  over: Record<string, unknown> = {},
): Promise<{ ok: boolean; status?: number; error?: string; next?: Chained }> {
  const body = {
    v: ENVELOPE_VERSION,
    idx: IDX,
    receipt: prev.receipt,
    nonce: prev.nonce,
    events: env.events.map((e) => ({ ...e, at: base + e.at })),
    ...(env.art ? { art: env.art } : {}),
    ...over,
  };
  const r = await verifyAttest(SECRET, RUN, IDX, body, now);
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  return {
    ok: true,
    next: {
      receipt: r.receipt,
      nonce: r.nonce,
      seq: r.tally.seq,
      events: r.tally.events,
      strokes: r.tally.strokes,
      intents: r.tally.intents,
      writes: r.tally.writes,
      filled: r.tally.filled,
      grid: decodeGrid(r.art ?? encodeGrid(emptyGrid()))!,
    },
  };
}

async function head(now: number): Promise<{ receipt: string; nonce: string }> {
  return {
    receipt: await openReceipt(SECRET, RUN, IDX),
    nonce: await nonceFor(SECRET, RUN, IDX, 0, now),
  };
}

/** Run the whole captured session and hand back every step. */
async function replayCaptured(now: number, base: number): Promise<Chained[]> {
  let chain = await head(now);
  const steps: Chained[] = [];
  for (const env of CAPTURED) {
    const r = await push(chain, env, now, base);
    if (!r.ok) throw new Error(`envelope ${steps.length} refused: ${r.error}`);
    steps.push(r.next!);
    chain = { receipt: r.next!.receipt, nonce: r.next!.nonce };
  }
  return steps;
}

const NOW = 1_770_000_000_000;
const BASE = NOW - 60_000;

/* ------------------------------------------------------------------ */

describe("write ledger codec", () => {
  test("round trips", () => {
    const runs = [
      { start: 0, len: 1, hue: 0 },
      { start: 5, len: 40, hue: 7 },
      { start: 4000, len: 96, hue: EMPTY },
    ];
    const s = encodeWrites(runs);
    expect(parseWrites(s)).toEqual(runs);
  });

  test("single-cell runs are three characters or fewer", () => {
    expect(encodeWrites([{ start: 0, len: 1, hue: 2 }])).toBe("c");
    expect(encodeWrites([{ start: 3, len: 1, hue: 2 }])).toBe("c3");
  });

  test("refuses garbage, overruns and empty lengths", () => {
    expect(parseWrites("zzz")).toBeNull();
    expect(parseWrites("a-")).toBeNull();
    // 4096 cells is the whole grid, so one more cannot be described.
    expect(parseWrites(`a-${CELLS.toString(36).toUpperCase()}`)).not.toBeNull();
    expect(parseWrites(`a1-${CELLS.toString(36).toUpperCase()}`)).toBeNull();
  });

  test("is sorted and non-overlapping by construction", () => {
    // Gaps are non-negative and every run advances the cursor past its own end,
    // so there is no spelling of "write cell 10 then cell 4" at all.
    const runs = parseWrites("a-4b2-4")!;
    expect(runs[0]!.start + runs[0]!.len).toBeLessThanOrEqual(runs[1]!.start);
  });
});

describe("a real captured Playwright session", () => {
  test("verifies end to end", async () => {
    const steps = await replayCaptured(NOW, BASE);
    expect(steps).toHaveLength(CAPTURED.length);

    const last = steps[steps.length - 1]!;
    expect(last.seq).toBe(CAPTURED.length);
    expect(last.strokes).toBe(9);
    expect(last.events).toBe(CAPTURED.length);
    // The server's own replay, not the client's string.
    expect(encodeGrid(last.grid)).toBe(CAPTURED[CAPTURED.length - 1]!.art!);
    expect(last.filled).toBeGreaterThan(1000);
  });

  test("the tally only ever moves forward across batches", async () => {
    const steps = await replayCaptured(NOW, BASE);
    for (let i = 1; i < steps.length; i++) {
      const a = steps[i - 1]!;
      const b = steps[i]!;
      expect(b.seq).toBe(a.seq + 1);
      expect(b.events).toBeGreaterThan(a.events);
      expect(b.strokes).toBeGreaterThanOrEqual(a.strokes);
      expect(b.writes).toBeGreaterThanOrEqual(a.writes);
    }
  });

  test("concurrent batches chained from receipt zero cannot be merged", async () => {
    // The 1105-solve shape, one level down: fan out from the same head and every
    // branch lands on a tally of one. There is no operation that adds them up.
    const chain = await head(NOW);
    const branches = await Promise.all(
      [0, 1, 2, 3].map(() => push(chain, CAPTURED[1]!, NOW, BASE)),
    );
    for (const b of branches) {
      expect(b.ok).toBe(true);
      expect(b.next!.seq).toBe(1);
      expect(b.next!.events).toBe(1);
    }
  });
});

describe("the ledger has to paint the canvas", () => {
  test("a missing write is caught", async () => {
    const chain = await head(NOW);
    const env = CAPTURED[1]!;
    const truncated = {
      ...env,
      events: [{ ...env.events[0]!, w: "a1-1Qa2-1Qa2-1Q" }], // three bands, not four
    };
    const r = await push(chain, truncated, NOW, BASE);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(r.error).toContain("do not paint that canvas");
  });

  test("a cell no stroke ever touched is caught", async () => {
    const chain = await head(NOW);
    const env = CAPTURED[1]!;
    const grid = decodeGrid(env.art!)!;
    grid[CELLS - 1] = 5; // one pixel the ledger never mentions
    const r = await push(chain, { ...env, art: encodeGrid(grid) }, NOW, BASE);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("do not paint that canvas");
  });

  test("the right writes in the wrong order are caught", async () => {
    // Both bands get painted either way; the intermediate canvas differs, and
    // the intermediate canvas is what each envelope has to show.
    const chain = await head(NOW);
    const first = await push(chain, CAPTURED[1]!, NOW, BASE);
    expect(first.ok).toBe(true);
    const shuffled = { ...CAPTURED[3]!, art: CAPTURED[2]!.art };
    const r = await push(
      { receipt: first.next!.receipt, nonce: first.next!.nonce },
      shuffled,
      NOW,
      BASE,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("do not paint that canvas");
  });

  test("an envelope that paints without showing its canvas is refused", async () => {
    const chain = await head(NOW);
    const r = await push(chain, { events: CAPTURED[1]!.events }, NOW, BASE);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("must show what it painted");
  });

  test("an envelope that paints nothing may still ask about the canvas", async () => {
    // Flushing a tool pick during a pause is normal and must not cost anything.
    const steps = await replayCaptured(NOW, BASE);
    const at = steps[1]!;
    const r = await push(
      { receipt: at.receipt, nonce: at.nonce },
      { events: [{ t: "view", at: 5000 }], art: CAPTURED[1]!.art },
      NOW,
      BASE,
    );
    expect(r.ok).toBe(true);
    expect(r.next!.writes).toBe(at.writes);
  });
});

describe("the envelope version", () => {
  test("a version-1 client is refused with a sentence that says so", async () => {
    const chain = await head(NOW);
    const r = await push(chain, CAPTURED[1]!, NOW, BASE, { v: undefined });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error).toContain("version 2");
  });

  test("so is a version from the future", async () => {
    const chain = await head(NOW);
    const r = await push(chain, CAPTURED[1]!, NOW, BASE, { v: 3 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("version 2");
  });
});

describe("receipts and replay", () => {
  test("a receipt from another run does not verify", async () => {
    const other = await openReceipt("a-different-run-secret", RUN, IDX);
    const r = await verifyAttest(
      SECRET, RUN, IDX,
      { v: ENVELOPE_VERSION, idx: IDX, receipt: other, nonce: await nonceFor(SECRET, RUN, IDX, 0, NOW), events: [{ t: "view", at: BASE }] },
      NOW,
    );
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("not ours");
  });

  test("a tampered payload does not verify", async () => {
    const good = await signReceipt(SECRET, RUN, IDX, { ...EMPTY_TALLY, events: 4 }, emptyGrid());
    const bad = await signReceipt(SECRET, RUN, IDX, { ...EMPTY_TALLY, events: 400 }, emptyGrid());
    const forged = `${bad.slice(0, bad.lastIndexOf("."))}.${good.slice(good.lastIndexOf(".") + 1)}`;
    expect(await bindReceipt(SECRET, RUN, IDX, forged, null)).toBeNull();
  });

  test("replaying an old receipt rewinds both the tally and the canvas", async () => {
    const steps = await replayCaptured(NOW, BASE);
    const old = steps[1]!;
    const now2 = NOW;

    // The old receipt is genuinely ours, so it verifies — and hands back the
    // smaller tally and the earlier grid it was signed over.
    const back = await bindReceipt(SECRET, RUN, IDX, old.receipt, null);
    expect(back).not.toBeNull();
    expect(back!.events).toBeLessThan(steps[steps.length - 1]!.events);

    // And it buys nothing: the batch that followed it assumed the *later*
    // canvas, so re-presenting it against the rewound one is refused.
    const r = await push(
      { receipt: old.receipt, nonce: old.nonce },
      CAPTURED[4]!,
      now2,
      BASE,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("do not paint that canvas");
  });

  test("a nonce from the wrong batch counter is refused", async () => {
    const steps = await replayCaptured(NOW, BASE);
    const at = steps[2]!;
    const r = await push(
      { receipt: at.receipt, nonce: await nonceFor(SECRET, RUN, IDX, 99, NOW) },
      CAPTURED[4]!,
      NOW,
      BASE,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("nonce");
  });
});

describe("timestamps", () => {
  test("must not go backwards across a batch boundary", async () => {
    const steps = await replayCaptured(NOW, BASE);
    const at = steps[4]!;
    const r = await push(
      { receipt: at.receipt, nonce: at.nonce },
      { events: [{ t: "view", at: 10 }] }, // earlier than everything attested
      NOW,
      BASE,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("out of order");
  });

  test("a batch prepared hours ago is refused", async () => {
    const chain = await head(NOW);
    const r = await push(chain, CAPTURED[1]!, NOW, NOW - 6 * 60 * 60 * 1000);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("too old");
  });

  test("uniform spacing is fine, because that is what page.mouse does", async () => {
    // Named as a test on purpose. `page.mouse.move()` emits perfectly even
    // gaps, and the previous version of this file rejected four in a row.
    const chain = await head(NOW);
    const events: AttestedEvent[] = [];
    for (let i = 0; i < 8; i++) events.push({ t: "view", at: i * 16 });
    const r = await push(chain, { events }, NOW, BASE);
    expect(r.ok).toBe(true);
    expect(r.next!.events).toBe(8);
  });
});

describe("the submit gate", () => {
  /** Paint `n` full rows of one hue as one legal stroke each, then submit. */
  async function session(rows: number, hue = 3) {
    let chain = await head(NOW);
    const grid = emptyGrid();
    let seq = 0;
    for (let r = 0; r < rows; r++) {
      grid.fill(hue, r * GRID, (r + 1) * GRID);
      const env: Envelope = {
        events: [
          {
            t: "stroke",
            at: 200 + r * 300,
            n: GRID,
            d: 120,
            w: encodeWrites([{ start: r * GRID, len: GRID, hue }]),
          },
        ],
        art: encodeGrid(grid),
      };
      const out = await push(chain, env, NOW, BASE);
      if (!out.ok) throw new Error(out.error);
      chain = { receipt: out.next!.receipt, nonce: out.next!.nonce };
      seq = out.next!.seq;
    }
    const done = await push(chain, { events: [{ t: "intent", at: 200 + rows * 300 }] }, NOW, BASE);
    if (!done.ok) throw new Error(done.error);
    return { receipt: done.next!.receipt, grid, seq };
  }

  test("a receipt spent on the grid its strokes painted clears", async () => {
    const s = await session(30);
    const t = await bindReceipt(SECRET, RUN, IDX, s.receipt, s.grid);
    expect(t).not.toBeNull();
    expect(t!.bound).toBe(true);
    expect(gateSubmit(t!, NOW)).toBeNull();
  });

  test("a receipt spent on a different grid does not", async () => {
    const s = await session(30);
    const other = Int8Array.from(s.grid);
    other[0] = 7;
    const t = await bindReceipt(SECRET, RUN, IDX, s.receipt, other);
    expect(t!.bound).toBe(false);
    expect(gateSubmit(t!, NOW)).toContain("not the one your attested strokes painted");
  });

  test("a receipt with no grid named at all does not", async () => {
    const s = await session(30);
    const t = await bindReceipt(SECRET, RUN, IDX, s.receipt, null);
    expect(t!.bound).toBe(false);
    expect(gateSubmit(t!, NOW)).toContain("not the one your attested strokes painted");
  });

  test("an unfinished grid is bankable-shaped, because probing is play", async () => {
    // Submitting a partial board is the observation channel. The gate must not
    // require a full canvas — only that the strokes paint whatever is shown.
    const s = await session(30);
    expect(s.grid.filter((v) => v >= 0).length).toBeLessThan(CELLS);
    const t = await bindReceipt(SECRET, RUN, IDX, s.receipt, s.grid);
    expect(gateSubmit(t!, NOW)).toBeNull();
  });

  test("the count and freshness floors still bite", async () => {
    const s = await session(4); // below GATE.strokes
    const t = (await bindReceipt(SECRET, RUN, IDX, s.receipt, s.grid))!;
    expect(gateSubmit(t, NOW)).toContain("did not arrive by painting");

    const full = await session(30);
    const t2 = (await bindReceipt(SECRET, RUN, IDX, full.receipt, full.grid))!;
    expect(gateSubmit(t2, NOW + 10 * 60 * 1000)).toContain("gone stale");
  });
});

describe("what this does not stop", () => {
  test("a script that decomposes its answer into strokes passes, by design", async () => {
    // This is the residual, written down as a test so it cannot be forgotten.
    // Nothing here is evidence about what moved the pointer. What the ledger
    // costs a forger is that the envelope must *contain* the answer as ordered
    // painting operations pushed through a chain that will not merge — which is
    // very nearly the cost of driving the page, and driving the page is free.
    let chain = await head(NOW);
    const target = emptyGrid();
    for (let i = 0; i < CELLS; i++) target[i] = (i * 7) % 8;
    const grid = emptyGrid();

    let receipt = "";
    for (let r = 0; r < GRID; r++) {
      const runs = [];
      for (let x = 0; x < GRID; x++) {
        const i = r * GRID + x;
        grid[i] = target[i]!;
        runs.push({ start: i, len: 1, hue: target[i]! });
      }
      const out = await push(
        chain,
        {
          events: [{ t: "stroke", at: 100 + r * 80, n: GRID, d: 40, w: encodeWrites(runs) }],
          art: encodeGrid(grid),
        },
        NOW,
        BASE,
      );
      expect(out.ok).toBe(true);
      chain = { receipt: out.next!.receipt, nonce: out.next!.nonce };
      receipt = out.next!.receipt;
    }
    const done = await push(chain, { events: [{ t: "intent", at: 100 + GRID * 80 }] }, NOW, BASE);
    receipt = done.next!.receipt;

    const t = (await bindReceipt(SECRET, RUN, IDX, receipt, target))!;
    expect(t.bound).toBe(true);
    expect(t.filled).toBe(CELLS);
    expect(gateSubmit(t, NOW)).toBeNull();
  });
});
