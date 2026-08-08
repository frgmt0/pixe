import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { encodeGrid } from "../shared/codec";
import { dialectPhase, dialectPuzzle } from "../shared/dialect";
import { phaseCountFor } from "../shared/generate";
import { CELLS, EMPTY, GRID, hueName } from "../shared/palette";
import { gridRows, PROTOCOL_VERSION } from "../shared/protocol";
import { handleRunApi } from "./runs";
import { sqliteStore } from "./store-sqlite";
import type { Store } from "./store";

/**
 * The whole API loop, end to end through the real router and a real database:
 * register, take a puzzle, probe it, bank it.
 *
 * Everything here goes through the ordinary request path rather than calling
 * the store directly, because the parts most likely to break are the seams —
 * token auth against the `:id` in the path, the probe counter, the one-open-
 * puzzle rule, and the shape of the two feedback channels. A test that reached
 * past those would pass while the product was broken.
 */

const DB = `/tmp/pixe-api-test-${process.pid}.sqlite`;
const store: Store = sqliteStore(DB);
afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB}${suffix}`, { force: true });
});

const deps = { store, ip: "127.0.0.1", secure: false };

async function call(
  method: "GET" | "POST",
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const url = `http://x${path}`;
  const res = await handleRunApi(
    new Request(url, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
    }),
    new URL(url),
    deps,
  );
  expect(res).not.toBeNull();
  return { status: res!.status, data: (await res!.json()) as Record<string, unknown> };
}

interface Run {
  runId: string;
  token: string;
}

async function register(over: Record<string, unknown> = {}): Promise<Run> {
  const r = await call("POST", "/api/bench/runs", undefined, {
    model: "test-model",
    provider: "test-provider",
    ...over,
  });
  expect(r.status).toBe(201);
  return { runId: r.data.runId as string, token: r.data.runToken as string };
}

/** Take the next rung and return the payload plus the board that solves it. */
async function take(run: Run) {
  const r = await call("POST", `/api/bench/runs/${run.runId}/next`, run.token);
  expect(r.status).toBe(200);
  const row = await store.runById(run.runId);
  const { target } = dialectPuzzle(row!.dialect, r.data.key as string);
  return { puzzle: r.data, target: Int8Array.from(target) };
}

const submit = (run: Run, grid: unknown, meter?: unknown) =>
  call("POST", `/api/bench/runs/${run.runId}/submit`, run.token, { grid, ...(meter ? { meter } : {}) });

const blank = () => {
  const g = new Int8Array(CELLS);
  g.fill(EMPTY);
  return g;
};

describe("registration", () => {
  test("declares a model and a provider, and gets a token back", async () => {
    const r = await call("POST", "/api/bench/runs", undefined, {
      model: "claude-opus-5",
      provider: "anthropic",
      config: "8 parallel painters",
    });
    expect(r.status).toBe(201);
    expect(r.data.protocol).toBe(PROTOCOL_VERSION);
    expect(r.data.model).toBe("claude-opus-5");
    expect(r.data.provider).toBe("anthropic");
    expect(r.data.config).toBe("8 parallel painters");
    expect(r.data.status).toBe("open");
    expect(typeof r.data.runToken).toBe("string");

    // The dialect is named, never handed over: the salt re-derives every law in
    // the run, so shipping it would end the benchmark.
    const row = await store.runById(r.data.runId as string);
    expect(r.data.dialect).not.toBe(row!.dialect);
  });

  test("a run that will not name itself is refused", async () => {
    expect((await call("POST", "/api/bench/runs", undefined, { model: "x" })).status).toBe(400);
    expect((await call("POST", "/api/bench/runs", undefined, {})).status).toBe(400);
  });

  test("no token, no run", async () => {
    const run = await register();
    expect((await call("POST", `/api/bench/runs/${run.runId}/next`)).status).toBe(401);

    // A valid token for another run must not act on this one.
    const other = await register();
    expect((await call("POST", `/api/bench/runs/${run.runId}/next`, other.token)).status).toBe(401);
  });

  /** A dead run is a different problem from a bad credential and needs a
   *  different fix, so it is told apart. Reaching the row needs a valid token
   *  for it, so saying so leaks nothing. */
  test("a closed run is refused as closed, not as unauthenticated", async () => {
    const run = await register();
    await store.closeRun(run.runId, Date.now(), "closed");
    const r = await call("POST", `/api/bench/runs/${run.runId}/next`, run.token);
    expect(r.status).toBe(403);
    expect(r.data.code).toBe("run_closed");
  });
});

describe("issuing", () => {
  test("hands over the board's structure and none of its laws", async () => {
    const run = await register();
    const { puzzle } = await take(run);

    expect(puzzle.idx).toBe(0);
    expect(puzzle.puzzleId).toBe(`${run.runId}:0`);
    expect(puzzle.width).toBe(GRID);
    expect(puzzle.height).toBe(GRID);
    expect(puzzle.cells).toBe(CELLS);
    expect(puzzle.rowMajor).toBe(true);
    expect((puzzle.palette as unknown[]).length).toBe(8);
    expect(typeof puzzle.issuedAt).toBe("number");

    // The whole benchmark rests on this. Any of these appearing is the end of it.
    for (const forbidden of ["rules", "scheme", "seed", "dialect", "hueSet", "target", "solution"]) {
      expect(puzzle[forbidden]).toBeUndefined();
    }
  });

  test("one puzzle at a time, and next will not take it away", async () => {
    const run = await register();
    await take(run);
    const second = await call("POST", `/api/bench/runs/${run.runId}/next`, run.token);
    expect(second.status).toBe(409);
    expect(second.data.code).toBe("open_issue");
    expect(second.data.idx).toBe(0);
  });

  test("run state names the open rung", async () => {
    const run = await register();
    const { puzzle } = await take(run);
    const me = await call("GET", `/api/bench/runs/${run.runId}`, run.token);
    expect(me.status).toBe(200);
    expect(me.data.solved).toBe(0);
    expect(me.data.open).toEqual({
      idx: 0,
      key: puzzle.key as string,
      issuedAt: puzzle.issuedAt as number,
      phase: 1,
      phases: puzzle.phases as number,
    });
  });
});

describe("submitting is also observing", () => {
  test("an unsolved grid is 200, feedback, and a probe", async () => {
    const run = await register();
    await take(run);

    // A solid board of one hue on a real puzzle: something is always wrong.
    const solid = new Int8Array(CELLS);
    solid.fill(0);
    const r = await submit(run, gridRows(solid as never));
    expect(r.status).toBe(200);
    expect(r.data.accepted).toBe(false);
    expect(r.data.filled).toBe(CELLS);
    expect(r.data.empty).toBe(0);
    expect(r.data.probes).toBe(1);

    const feedback = r.data.feedback as { flashes: { x: number; y: number }[]; buzzes: string[] };
    // The invariant from `shared/engine.test.ts`, restated on the wire: on a
    // full grid no failing law is invisible, so a refusal must say something.
    expect(feedback.flashes.length + feedback.buzzes.length).toBeGreaterThan(0);
    for (const f of feedback.flashes) {
      expect(f.x).toBeGreaterThanOrEqual(0);
      expect(f.x).toBeLessThan(GRID);
      expect(f.y).toBeGreaterThanOrEqual(0);
      expect(f.y).toBeLessThan(GRID);
    }
    // Colour names, never a law, a threshold or a direction.
    for (const b of feedback.buzzes) {
      expect(Array.from({ length: 8 }, (_, i) => hueName(i))).toContain(b);
    }

    const again = await submit(run, gridRows(solid as never));
    expect(again.data.probes).toBe(2);
    // Every request against the open rung is counted, probe or not — the two
    // agree here only because both requests happened to teach something.
    expect(again.data.apiCalls).toBe(2);
  });

  /**
   * The silence rule, which is the one an agent will misread most expensively.
   * A counting law that is merely unfinished must stay quiet while blank cells
   * remain — the board does not nag about a requirement you could still go on
   * to meet — so an empty board can only ever flash, never buzz.
   */
  test("counting laws stay silent while blanks remain", async () => {
    const run = await register();
    await take(run);
    const r = await submit(run, gridRows(blank() as never));
    expect(r.status).toBe(200);
    expect(r.data.accepted).toBe(false);
    expect(r.data.filled).toBe(0);
    expect(r.data.empty).toBe(CELLS);
    expect((r.data.feedback as { buzzes: string[] }).buzzes).toEqual([]);
  });

  test("every accepted grid shape reaches the same verdict", async () => {
    const run = await register();
    const { target } = await take(run);
    const rows = gridRows(target as never);
    const nums = rows.map((row) => [...row].map((c) => (c === "." ? -1 : c.charCodeAt(0) - 97)));

    // Rows first — this one banks. The other two then take the already-solved
    // branch, which is the proof that all three decoded to the same board.
    expect((await submit(run, rows)).data.accepted).toBe(true);
    for (const shape of [nums, encodeGrid(target as never)]) {
      const r = await submit(run, shape);
      expect(r.status).toBe(404);
      expect(r.data.code).toBe("no_open_issue");
    }
  });

  test("a grid the server cannot read is 422 and costs no probe", async () => {
    const run = await register();
    await take(run);
    const r = await submit(run, "not a grid");
    expect(r.status).toBe(422);
    expect(r.data.code).toBe("bad_grid");
    expect(await store.probeCount(run.runId, 0)).toBe(0);
  });
});

describe("banking a solve", () => {
  test("the reference solution is accepted, banked and shareable", async () => {
    const run = await register();
    const { puzzle, target } = await take(run);

    const probe = await submit(run, gridRows(blank() as never));
    expect(probe.data.accepted).toBe(false);

    const r = await submit(run, gridRows(target as never), { tokensIn: 900, costMicro: 4500 });
    expect(r.status).toBe(200);
    expect(r.data.accepted).toBe(true);
    expect(r.data.alreadySolved).toBe(false);
    expect(r.data.key).toBe(puzzle.key as string);
    expect(r.data.points as number).toBeGreaterThan(0);
    expect(typeof r.data.shareId).toBe("string");
    expect(r.data.solved).toBe(1);
    // The post-solve reveal: safe only because this board is banked.
    expect((r.data.reveal as { rules: unknown[] }).rules.length).toBeGreaterThan(0);

    const row = (await store.solveAt(run.runId, 0))!;
    expect(row.share_id).toBe(r.data.shareId as string);
    // Server-measured, and the reason these metrics cannot be self-reported.
    expect(row.probes).toBe(1);
    expect(row.wall_ms).toBeGreaterThanOrEqual(0);
    expect(row.tokens_in).toBe(900);
    expect(row.cost_micro).toBe(4500);

    // The issue closes, which is what frees the run to draw the next rung.
    const closed = await store.issueAt(run.runId, 0);
    expect(closed!.outcome).toBe("solved");
    expect(closed!.closed_at).not.toBeNull();
  });

  test("the next rung is a real board, derived from the one just banked", async () => {
    const run = await register();
    const first = await take(run);
    expect((await submit(run, gridRows(first.target as never))).data.accepted).toBe(true);

    const second = await take(run);
    expect(second.puzzle.idx).toBe(1);
    expect(second.puzzle.key).not.toBe(first.puzzle.key);
    expect((await submit(run, gridRows(second.target as never))).data.accepted).toBe(true);

    const me = await call("GET", `/api/bench/runs/${run.runId}`, run.token);
    expect(me.data.solved).toBe(2);
  });

  /**
   * Banking closes the issue, so a *sequential* re-submit gets 404 — there is
   * no open puzzle left to submit to. The `alreadySolved` branch exists for the
   * race the insert guards against: two submissions in flight at once, both
   * finding no existing solve, both inserting. Firing them concurrently is the
   * only way to reach it, and it is worth reaching, because the alternative to
   * `ON CONFLICT DO NOTHING` here is one dropped connection turning into a
   * permanently lost solve.
   */
  test("concurrent submissions of the same solve pay exactly once", async () => {
    const run = await register();
    const { target } = await take(run);
    const rows = gridRows(target as never);
    const send = () => submit(run, rows);

    const results = await Promise.all([send(), send(), send(), send()]);
    const banked = results.filter((r) => r.data.accepted === true);
    expect(banked.length).toBeGreaterThan(0);
    // Whatever the interleaving, exactly one payment and one share id.
    expect(banked.filter((r) => (r.data.points as number) > 0).length).toBe(1);
    expect(new Set(banked.map((r) => r.data.shareId as string)).size).toBe(1);

    // One row, not four — the UNIQUE(run_id, idx) fallback did its job.
    expect((await store.runSolves(run.runId)).length).toBe(1);
  });
});

describe("abandoning", () => {
  test("costs a minute of holding the board before it is allowed", async () => {
    const run = await register();
    await take(run);
    const r = await call("POST", `/api/bench/runs/${run.runId}/abandon`, run.token);
    expect(r.status).toBe(429);
    expect(r.data.code).toBe("rate_limited");
    expect(r.data.retryAfterMs as number).toBeGreaterThan(0);
    expect((await store.openIssue(run.runId))!.idx).toBe(0);
  });

  test("closes the rung as abandoned and advances the chain past it", async () => {
    const run = await register();
    await take(run);

    // Backdate the issue rather than sleep for a minute: the rule under test is
    // the cooldown's arithmetic, not the clock's ability to advance.
    await rewriteIssuedAt(run.runId, 0, Date.now() - 61_000);

    const r = await call("POST", `/api/bench/runs/${run.runId}/abandon`, run.token);
    expect(r.status).toBe(200);
    expect(r.data.abandoned).toBe(0);
    expect(r.data.charged).toBe(true);
    expect((await store.issueAt(run.runId, 0))!.outcome).toBe("abandoned");

    // Abandoning does not re-roll the rung you left: it consumes its number.
    const next = await call("POST", `/api/bench/runs/${run.runId}/next`, run.token);
    expect(next.data.idx).toBe(1);

    // And nothing was banked for it, which is what makes the time a pure cost.
    expect((await store.runSolves(run.runId)).length).toBe(0);
  });

  test("there is nothing to abandon between boards", async () => {
    const run = await register();
    const r = await call("POST", `/api/bench/runs/${run.runId}/abandon`, run.token);
    expect(r.status).toBe(404);
    expect(r.data.code).toBe("no_open_issue");
  });
});

/**
 * Multi-phase rungs, walked end to end through the real router.
 *
 * A rung at the top of the ladder is a chain of boards: accepting phase k hands
 * back phase k+1 in the same response, on the same clock, and nothing is banked
 * until the last one lands. The rung is opened directly through the store
 * rather than by climbing to it, because the difficulty band would take twenty
 * solved boards to reach a three-phase key and the thing under test is the
 * handoff, not the band.
 */
describe("multi-phase rungs", () => {
  const KEY = "L400";

  /** Opens a rung on a chosen key. `/next` picks keys; a test needs one key. */
  async function openRung(run: Run): Promise<{ dialect: string; payload: Record<string, unknown> }> {
    await store.insertIssue(run.runId, 0, KEY, Date.now());
    const row = await store.runById(run.runId);
    // `next` refuses an open board, and hands the payload back with the refusal
    // so a crashed runner can pick the rung up again. That is the only way to
    // read an open board, and it is what this uses.
    const r = await call("POST", `/api/bench/runs/${run.runId}/next`, run.token);
    expect(r.status).toBe(409);
    return { dialect: row!.dialect, payload: r.data.open as Record<string, unknown> };
  }

  test("the whole chain: three boards, one clock, one bank at the end", async () => {
    expect(phaseCountFor(KEY)).toBe(3);
    const run = await register();
    const { dialect, payload } = await openRung(run);

    expect(payload.phase).toBe(1);
    expect(payload.phases).toBe(3);
    expect(payload.locked).toEqual([]);
    // Still no laws, at any phase. This is the line that must never move.
    for (const forbidden of ["rules", "scheme", "seed", "dialect", "hueSet", "target"]) {
      expect(payload[forbidden]).toBeUndefined();
    }

    const priors: Int8Array[] = [];
    let phasePointsTotal = 0;

    for (let phase = 1; phase <= 3; phase++) {
      const { puzzle, target } = dialectPhase(dialect, KEY, phase, priors);
      const r = await submit(run, gridRows(target as never));
      expect(r.status).toBe(200);
      expect(r.data.accepted).toBe(true);
      expect(r.data.phase).toBe(phase);
      expect(r.data.phases).toBe(3);
      expect(r.data.phasePoints).toBe(puzzle.points);
      phasePointsTotal += puzzle.points;

      if (phase < 3) {
        // A handoff banks nothing: no points, no share, and the rung stays open.
        expect(r.data.rungComplete).toBe(false);
        expect(r.data.points).toBe(0);
        expect(r.data.shareId).toBeNull();
        expect(r.data.reveal).toBeNull();
        expect(await store.solveAt(run.runId, 0)).toBeNull();
        expect((await store.openIssue(run.runId))!.idx).toBe(0);

        const next = r.data.next as Record<string, unknown>;
        expect(next.phase).toBe(phase + 1);
        expect(next.phases).toBe(3);
        expect(next.key).toBe(KEY);
        // Carried-over cells arrive with the board, so the agent never has to
        // guess which of its own pixels it is being held to.
        expect((next.locked as unknown[]).length).toBeGreaterThan(0);
        // The clock does not restart at a handoff.
        expect(next.issuedAt).toBe(payload.issuedAt);
      } else {
        expect(r.data.rungComplete).toBe(true);
        expect(r.data.next).toBeNull();
        expect(r.data.points).toBe(phasePointsTotal);
        expect(typeof r.data.shareId).toBe("string");
        const reveal = r.data.reveal as { phases: unknown[] };
        // All the laws, or none of them. A rung reveals as a unit because
        // phase 2's board was derived from the answer to phase 1's.
        expect(reveal.phases.length).toBe(3);
      }
      priors.push(Int8Array.from(target));
    }

    const solve = (await store.solveAt(run.runId, 0))!;
    expect(solve.points).toBe(phasePointsTotal);
    // A three-phase rung is worth more than any single board can be.
    expect(solve.points).toBeGreaterThan(12);
    const closed = await store.issueAt(run.runId, 0);
    expect(closed!.outcome).toBe("solved");
    expect(closed!.phase).toBe(3);
  }, 60_000);

  test("a locked cell painted over is refused, and the cell flashes", async () => {
    const run = await register();
    const { dialect } = await openRung(run);

    const first = dialectPhase(dialect, KEY, 1, []).target;
    const handoff = await submit(run, gridRows(first as never));
    expect(handoff.data.rungComplete).toBe(false);

    const priors = [Int8Array.from(first)];
    const { puzzle, target } = dialectPhase(dialect, KEY, 2, priors);
    const locked = puzzle.locked[0]!;
    const g = Int8Array.from(target);
    g[locked.y * GRID + locked.x] = (locked.hue + 1) % 8;

    const r = await submit(run, gridRows(g as never));
    expect(r.data.accepted).toBe(false);
    expect(r.data.phase).toBe(2);
    const flashes = (r.data.feedback as { flashes: { x: number; y: number }[] }).flashes;
    expect(flashes).toContainEqual({ x: locked.x, y: locked.y });
  }, 60_000);

  test("run state and the open-issue refusal both name the phase", async () => {
    const run = await register();
    const { dialect } = await openRung(run);
    const first = dialectPhase(dialect, KEY, 1, []).target;
    await submit(run, gridRows(first as never));

    const me = await call("GET", `/api/bench/runs/${run.runId}`, run.token);
    expect(me.data.open).toEqual({ idx: 0, key: KEY, issuedAt: expect.any(Number), phase: 2, phases: 3 });

    const refused = await call("POST", `/api/bench/runs/${run.runId}/next`, run.token);
    expect(refused.status).toBe(409);
    expect(refused.data.phase).toBe(2);
    expect(((refused.data.open as Record<string, unknown>).locked as unknown[]).length).toBeGreaterThan(0);
  }, 60_000);
});

/** The one thing no store method exposes, because nothing in the product moves
 *  a clock backwards. Reaching for the database directly is the honest way to
 *  say that this is a test fixture and not a feature. */
async function rewriteIssuedAt(runId: string, idx: number, at: number): Promise<void> {
  const { Database } = await import("bun:sqlite");
  const db = new Database(DB);
  db.query("UPDATE issues SET issued_at = ? WHERE run_id = ? AND idx = ?").run(at, runId, idx);
  db.close();
}
