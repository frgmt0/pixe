import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { encodeGrid } from "../shared/codec";
import { dialectPuzzle, newDialectSalt } from "../shared/dialect";
import { CELLS, EMPTY } from "../shared/palette";
import { ENVELOPE_VERSION, GATE } from "./attest";
import { handleRunApi, mintToken } from "./runs";
import { sqliteStore } from "./store-sqlite";
import type { RunRow, Store } from "./store";

/**
 * The banked branch of `POST /api/submit`, end to end through the real router
 * and a real database.
 *
 * This is the highest-value path in the product — it is the one that writes a
 * `run_solves` row, mints a share id and advances the chain — and it had no
 * automated coverage at all. It was exercised only by a human clicking a button
 * in a browser, which meant a regression that broke banking would have left the
 * suite green.
 *
 * Everything here goes through the ordinary request path rather than calling
 * the store directly, because the parts most likely to break are the seams:
 * attestation binding the receipt to the grid, the gate thresholds, and the
 * probe counter. A test that reached past those would pass while the product
 * was broken.
 */

const DB = `/tmp/pixe-submit-test-${process.pid}.sqlite`;
const store: Store = sqliteStore(DB);
afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB}${suffix}`, { force: true });
});

const LEDGER_CHARS = "abcdefghi";

interface WriteRun {
  start: number;
  len: number;
  hue: number;
}

/** The client-side ledger encoder, mirrored. Grammar lives in `attest.ts`. */
function encodeWrites(runs: readonly WriteRun[]): string {
  let out = "";
  let end = 0;
  for (const r of runs) {
    const gap = r.start - end;
    out += LEDGER_CHARS[r.hue < 0 ? 8 : r.hue];
    if (gap > 0) out += gap.toString(36).toUpperCase();
    if (r.len > 1) out += `-${r.len.toString(36).toUpperCase()}`;
    end = r.start + r.len;
  }
  return out;
}

/** Contiguous same-hue spans of a grid, i.e. the strokes that would paint it. */
function runsOf(grid: Int8Array): WriteRun[] {
  const out: WriteRun[] = [];
  let i = 0;
  while (i < CELLS) {
    const hue = grid[i]!;
    let j = i + 1;
    while (j < CELLS && grid[j] === hue) j++;
    out.push({ start: i, len: j - i, hue });
    i = j;
  }
  return out;
}

/** Split into at least `n` chunks, so the batch clears `GATE.strokes`. */
function chunk<T>(xs: readonly T[], n: number): T[][] {
  const size = Math.max(1, Math.ceil(xs.length / n));
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** A real operator, because a banked run is by definition a paired one. */
async function newOperator(): Promise<string> {
  const now = Date.now();
  const id = `op${Math.random().toString(36).slice(2, 12)}`;
  await store.createOperator({
    id,
    key_hash: `hash-${id}`,
    display: "Test Human",
    harness: "test-harness",
    config: null,
    contact: null,
    created_at: now,
    last_at: now,
  });
  return id;
}

async function newRun(): Promise<{ run: RunRow; token: string; key: string; target: Int8Array }> {
  const now = Date.now();
  const id = `run${Math.random().toString(36).slice(2, 15)}`.slice(0, 16).padEnd(16, "x");
  const run = await store.createRun({
    id,
    secret: "5eba1b1a5eba1b1a5eba1b1a5eba1b1a",
    harness: "test-harness",
    config: null,
    operator_id: await newOperator(),
    dialect: newDialectSalt(),
    created_at: now,
    last_at: now,
    status: "open",
  });
  const key = "L4";
  await store.insertIssue(run.id, 0, key, now);
  const { target } = dialectPuzzle(run.dialect, key);
  return { run, token: await mintToken(run), key, target: Int8Array.from(target) };
}

const deps = { store, ip: "127.0.0.1", secure: false };

const call = (path: string, token: string, body?: unknown) =>
  handleRunApi(
    new Request(`http://x${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body ?? {}),
    }),
    new URL(`http://x${path}`),
    deps,
  );

/**
 * Paint the whole target through `/api/attest`, the way the page does: several
 * batches of stroke events, each carrying the cells it wrote and the canvas
 * those writes produce. Returns the receipt that covers the finished board.
 */
async function paint(token: string, target: Int8Array, receipt: string, nonce: string) {
  const canvas = new Int8Array(CELLS).fill(EMPTY);
  const batches = chunk(runsOf(target), Math.max(GATE.strokes, 10));
  // Spread over more than `GATE.spanMs`, and end at `now` so the tally is fresh
  // when submit reads it.
  const span = GATE.spanMs * 2;
  const start = Date.now() - span;
  const step = Math.floor(span / (batches.length + 1));

  let cur = { receipt, nonce };
  for (let b = 0; b < batches.length; b++) {
    const runs = batches[b]!;
    for (const r of runs) canvas.fill(r.hue, r.start, r.start + r.len);
    const at = start + step * (b + 1);
    const events = [
      { t: "pick", at, n: runs[0]!.hue },
      { t: "stroke", at: at + 1, n: runs.length, d: 5, w: encodeWrites(runs) },
      { t: "view", at: at + 2 },
      // The last batch carries the intent, which is what a submit click emits.
      ...(b === batches.length - 1 ? [{ t: "intent", at: at + 3 }] : []),
    ];
    const res = await call("/api/attest", token, {
      v: ENVELOPE_VERSION,
      idx: 0,
      nonce: cur.nonce,
      receipt: cur.receipt,
      events,
      art: encodeGrid(canvas as never),
    });
    expect(res).not.toBeNull();
    const body = (await res!.json()) as Record<string, string>;
    expect(res!.status).toBe(200);
    cur = { receipt: body.receipt!, nonce: body.nonce! };
  }
  return { ...cur, art: encodeGrid(canvas as never) };
}

describe("banking a solve", () => {
  test("a genuinely painted solution is accepted, banked and shareable", async () => {
    const { run, token, target } = await newRun();
    const issue = (await store.openIssue(run.id))!;
    const board = await call("/api/board", token);
    const seed = (await board!.json()) as Record<string, string>;

    const painted = await paint(token, target, seed.receipt!, seed.nonce!);
    const res = await call("/api/submit", token, { art: painted.art, receipt: painted.receipt });
    const body = (await res!.json()) as Record<string, unknown>;

    // The whole point: this must be the accepted branch, not a 403 from a gate
    // or a 400 from the receipt binding.
    expect(res!.status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(typeof body.shareId).toBe("string");
    expect(body.points as number).toBeGreaterThan(0);

    const row = (await store.solveAt(run.id, 0))!;
    expect(row).toBeTruthy();
    expect(row.share_id).toBe(body.shareId as string);
    // Server-measured, and the reason the metric cannot be self-reported.
    expect(row.probes).toBeGreaterThan(0);
    expect(row.wall_ms).toBeGreaterThanOrEqual(0);

    // The issue closes, which is what frees the run to draw the next rung.
    const closed = await store.issueAt(run.id, issue.idx);
    expect(closed!.outcome).toBe("solved");
    expect(closed!.closed_at).not.toBeNull();
  });

  /**
   * Banking closes the issue, so a *sequential* re-submit gets 404 rather than
   * the `alreadySolved` branch — there is no open puzzle left to submit to.
   * That branch exists for the race the insert guards against: two submissions
   * in flight at once, both finding no existing solve, both inserting. Firing
   * them concurrently is the only way to reach it, and it is worth reaching,
   * because the alternative to `ON CONFLICT DO NOTHING` here is one dropped
   * connection turning into a permanently lost solve.
   */
  test("concurrent submissions of the same solve pay exactly once", async () => {
    const { run, token, target } = await newRun();
    const seed = (await (await call("/api/board", token))!.json()) as Record<string, string>;
    const painted = await paint(token, target, seed.receipt!, seed.nonce!);
    const send = () => call("/api/submit", token, { art: painted.art, receipt: painted.receipt });

    const bodies = (await Promise.all(
      (await Promise.all([send(), send(), send(), send()])).map((r) => r!.json()),
    )) as Record<string, unknown>[];

    const banked = bodies.filter((b) => b.accepted === true);
    expect(banked.length).toBeGreaterThan(0);
    // Whatever the interleaving, exactly one payment and one share id.
    expect(banked.filter((b) => (b.points as number) > 0).length).toBe(1);
    const ids = new Set(banked.map((b) => b.shareId as string));
    expect(ids.size).toBe(1);

    // One row, not four — the UNIQUE(run_id, idx) fallback did its job.
    expect((await store.runSolves(run.id)).length).toBe(1);
  });
});
