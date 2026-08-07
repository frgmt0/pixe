import { describe, expect, test } from "bun:test";
import { encodeGrid } from "./codec";
import { CELLS } from "./palette";
import { emptyGrid } from "./rules";
import {
  MAX_ATTEST_PAYLOAD,
  MAX_LABEL,
  PUZZLE_UNIVERSE,
  RUN_COOKIE,
  chartPointOf,
  clearRunCookie,
  isRunId,
  label,
  median,
  meterToRow,
  parseAttestEnvelope,
  parseRegisterRun,
  parseSubmit,
  percentile,
  projected1mCostUsd,
  projected1mHours,
  runCookie,
  runTokenFrom,
  solutionDigest,
  type RunRow,
  type RunSolveRow,
} from "./protocol";

const FULL_GRID = encodeGrid((() => {
  const g = emptyGrid();
  g.fill(0);
  return g;
})());

/** Anything a body validator is handed could be any of these. */
const HOSTILE: unknown[] = [
  null,
  undefined,
  0,
  -1,
  NaN,
  Infinity,
  "",
  "{}",
  true,
  [],
  [1, 2, 3],
  new Date(),
  { __proto__: { agent: "sneaky" } },
];

describe("run identifiers", () => {
  test("accepts only 16 url-safe characters", () => {
    expect(isRunId("aB3-_xyz09QWERTy")).toBe(true);
    expect(isRunId("short")).toBe(false);
    expect(isRunId("seventeen_chars__")).toBe(false);
    expect(isRunId("has spaces here!")).toBe(false);
    expect(isRunId("../../etc/passwd")).toBe(false);
    for (const v of HOSTILE) expect(isRunId(v)).toBe(false);
  });
});

describe("run token extraction", () => {
  const withHeaders = (h: Record<string, string>) => new Request("https://pixe.test/api/board", { headers: h });

  test("reads a bearer token", () => {
    expect(runTokenFrom(withHeaders({ authorization: "Bearer abcdefghijklmnop" })))
      .toBe("abcdefghijklmnop");
  });

  test("reads the cookie", () => {
    expect(runTokenFrom(withHeaders({ cookie: `other=1; ${RUN_COOKIE}=abcdefghijklmnop; z=2` })))
      .toBe("abcdefghijklmnop");
  });

  // A script that just registered a fresh run must not be answered as whatever
  // stale run the browser profile still holds a cookie for.
  test("the header beats a stale cookie", () => {
    const req = withHeaders({
      authorization: "Bearer HEADERtokenAAAAAA",
      cookie: `${RUN_COOKIE}=COOKIEtokenBBBBBB`,
    });
    expect(runTokenFrom(req)).toBe("HEADERtokenAAAAAA");
  });

  test("rejects malformed and absent credentials", () => {
    expect(runTokenFrom(withHeaders({}))).toBe(null);
    expect(runTokenFrom(withHeaders({ authorization: "Basic abcdefghijklmnop" }))).toBe(null);
    expect(runTokenFrom(withHeaders({ authorization: "Bearer short" }))).toBe(null);
    expect(runTokenFrom(withHeaders({ authorization: `Bearer ${"x".repeat(400)}` }))).toBe(null);
    expect(runTokenFrom(withHeaders({ cookie: `${RUN_COOKIE}=` }))).toBe(null);
    expect(runTokenFrom(withHeaders({ cookie: `${RUN_COOKIE}=has;semi` }))).toBe(null);
    expect(runTokenFrom(withHeaders({ cookie: "pixe_runner=abcdefghijklmnop" }))).toBe(null);
  });
});

describe("run cookie", () => {
  test("is HttpOnly and only Secure off plain http", () => {
    expect(runCookie("tok", true)).toContain("HttpOnly");
    expect(runCookie("tok", true)).toContain("Secure");
    expect(runCookie("tok", false)).not.toContain("Secure");
    expect(clearRunCookie(true)).toContain("Max-Age=0");
  });
});

describe("parseRegisterRun", () => {
  test("registration declares nothing, so an empty body is the whole body", () => {
    const r = parseRegisterRun({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({});
  });

  // `agent` and `model` were removed rather than deprecated. A solver written
  // against the older spec still registers; its labels are simply not read.
  test("ignores the identity fields the protocol used to carry", () => {
    expect(parseRegisterRun({ agent: "claude-code", model: "claude-opus-5" }).ok).toBe(true);
  });

  // A harness in the body is ignored rather than refused — see the note on
  // `parseRegisterRun` — but it must never survive the parse, because the value
  // that survives is the one that could reach a row.
  test("carries no harness through, whatever the body says", () => {
    for (const harness of ["playwright", "Claude Code", " x ", undefined, null, ""]) {
      const r = parseRegisterRun({ harness });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual({});
    }
  });

  test("rejects every body that is not a JSON object", () => {
    // Two entries in HOSTILE are objects, and an object body is now valid
    // however it is furnished: there is nothing in it to read.
    const isObjectBody = (v: unknown) =>
      typeof v === "object" && v !== null && !Array.isArray(v);
    for (const v of HOSTILE) expect(parseRegisterRun(v).ok).toBe(isObjectBody(v));
  });
});

/*
 * The harness and config a human types land straight in the public benchmark
 * table, so the sanitiser is tested where it now lives rather than through a
 * registration body that no longer carries either.
 */
describe("label", () => {
  test("flattens control characters and collapses whitespace", () => {
    expect(label("ev il\n\nagent\u200b")).toBe("ev il agent");
    expect(label("  m\tm  ")).toBe("m m");
  });

  test("rejects anything that is not a string", () => {
    expect(label(7)).toBe(null);
    expect(label(["a"])).toBe(null);
    expect(label({ toString: () => "a" })).toBe(null);
    expect(label(undefined)).toBe(null);
  });

  test("rejects whitespace-only and over-long labels", () => {
    expect(label("   ")).toBe(null);
    expect(label("\n\t ")).toBe(null);
    expect(label("a".repeat(MAX_LABEL))).toBe("a".repeat(MAX_LABEL));
    expect(label("a".repeat(MAX_LABEL + 1))).toBe(null);
    expect(label("a".repeat(100_000))).toBe(null);
  });
});

describe("parseSubmit", () => {
  test("accepts a well-formed grid and hands back the decoded board", () => {
    const r = parseSubmit({ art: FULL_GRID });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.grid.length).toBe(CELLS);
      expect(r.value.meter).toBe(null);
      expect(r.value.attest).toBe(null);
    }
  });

  test("rejects anything the codec cannot read", () => {
    for (const art of ["", "zzz", "a", "a0", "a-1", "aZZZZZZZZZ", "a1", "%00", "a".repeat(50_000)]) {
      const r = parseSubmit({ art });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("bad_grid");
    }
    for (const v of HOSTILE) expect(parseSubmit(v).ok).toBe(false);
    expect(parseSubmit({ art: 12345 }).ok).toBe(false);
    expect(parseSubmit({ art: { toString: () => FULL_GRID } }).ok).toBe(false);
  });

  test("takes a self-reported meter", () => {
    const r = parseSubmit({ art: FULL_GRID, meter: { tokensIn: 100, tokensOut: 20, costMicro: 4500 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.meter).toEqual({ tokensIn: 100, tokensOut: 20, costMicro: 4500 });
  });

  test("a partially reported meter keeps its holes", () => {
    const r = parseSubmit({ art: FULL_GRID, meter: { tokensIn: 100 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.meter).toEqual({ tokensIn: 100, tokensOut: null, costMicro: null });
  });

  test("an entirely empty meter is the same as no meter", () => {
    const r = parseSubmit({ art: FULL_GRID, meter: {} });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.meter).toBe(null);
  });

  test("rejects the whole float zoo in the meter", () => {
    // `[]` is in here deliberately: Number([]) is 0, so a validator that
    // coerced before type-checking would bank an empty array as a reported zero.
    for (const tokensIn of [-1, 1.5, NaN, Infinity, -Infinity, 1e309, "100", [], {}, 1e13]) {
      expect(parseSubmit({ art: FULL_GRID, meter: { tokensIn } }).ok).toBe(false);
    }
    expect(parseSubmit({ art: FULL_GRID, meter: { costMicro: -1 } }).ok).toBe(false);
    expect(parseSubmit({ art: FULL_GRID, meter: "lots" }).ok).toBe(false);
    expect(parseSubmit({ art: FULL_GRID, meter: [] }).ok).toBe(false);
  });

  // Reporting is optional, so declining to report has to be a legal submit
  // rather than a malformed body. An explicit null is a run saying "not this
  // one", which is different from a run saying zero.
  test("an explicit null is unreported, not malformed", () => {
    const r = parseSubmit({
      art: FULL_GRID,
      meter: { tokensIn: null, tokensOut: 40, costMicro: null },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.meter).toEqual({ tokensIn: null, tokensOut: 40, costMicro: null });
  });

  test("a reported zero survives as zero, not as unreported", () => {
    const r = parseSubmit({ art: FULL_GRID, meter: { tokensIn: 0, tokensOut: 0, costMicro: 0 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.meter).toEqual({ tokensIn: 0, tokensOut: 0, costMicro: 0 });
  });
});

describe("attestation envelope", () => {
  const good = { v: 1, idx: 3, payload: "opaque-to-this-module" };

  test("checks the envelope and nothing about the payload", () => {
    const r = parseAttestEnvelope(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.payload).toBe(good.payload);
  });

  test("rejects malformed envelopes with an attestation code", () => {
    const bad: unknown[] = [
      ...HOSTILE,
      { v: 0, idx: 0, payload: "x" },
      { v: 1.5, idx: 0, payload: "x" },
      { v: 1, idx: -1, payload: "x" },
      { v: 1, idx: 0 },
      { v: 1, idx: 0, payload: "" },
      { v: 1, idx: 0, payload: 42 },
      { v: 1, idx: 0, payload: "x".repeat(MAX_ATTEST_PAYLOAD + 1) },
    ];
    for (const v of bad) {
      const r = parseAttestEnvelope(v);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("attestation_invalid");
    }
  });

  test("rides along on a submit", () => {
    const r = parseSubmit({ art: FULL_GRID, attest: good });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.attest).toEqual(good);
  });

  test("a broken envelope fails the whole submit", () => {
    const r = parseSubmit({ art: FULL_GRID, attest: { v: 1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("attestation_invalid");
  });
});

describe("the chained sequence", () => {
  // The key derivation itself is server-side and tested in `server/runs.test.ts`.
  // It was briefly asserted here against a `chainLabel` helper that no server
  // code called — including a test insisting an abandoned rung re-rolls in
  // place, which is not what the server does. A test can only be as correct as
  // the thing it is pointed at.

  // The codec accepts non-canonical encodings, so digesting the client's own
  // string would let a solver re-encode an accepted grid until it liked the
  // next key. Taking a Grid forces the canonical form.
  test("the digest is of the canonical encoding, not the submitted text", async () => {
    const g = emptyGrid();
    g.fill(0);
    const canonical = await solutionDigest(g);
    const reparsed = parseSubmit({ art: "a1".repeat(0) + encodeGrid(g) });
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) expect(await solutionDigest(reparsed.value.grid)).toBe(canonical);

    const padded = parseSubmit({ art: `a1a${(CELLS - 1).toString(36).toUpperCase()}` });
    expect(padded.ok).toBe(true);
    if (padded.ok) expect(await solutionDigest(padded.value.grid)).toBe(canonical);
  });

  test("a different grid digests differently", async () => {
    const a = emptyGrid();
    a.fill(0);
    const b = emptyGrid();
    b.fill(0);
    b[0] = 1;
    expect(await solutionDigest(a)).not.toBe(await solutionDigest(b));
    expect((await solutionDigest(a)).length).toBe(64);
  });
});

describe("metrics", () => {
  test("median handles odd, even and empty", () => {
    expect(median([])).toBe(0);
    expect(median([5])).toBe(5);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([4, 1, 3, 2])).toBe(3);
  });

  test("p90 is a rank, so it is always an observation that happened", () => {
    const xs = Array.from({ length: 10 }, (_, i) => (i + 1) * 100);
    expect(percentile(xs, 90)).toBe(900);
    expect(percentile(xs, 100)).toBe(1000);
    expect(percentile(xs, 0)).toBe(100);
    expect(percentile([], 90)).toBe(0);
  });

  test("the 1M projections are serial wall clock and plain dollars", () => {
    // One second per puzzle over a million puzzles is 277.8 hours.
    expect(projected1mHours(1000)).toBeCloseTo(277.777, 2);
    // A cent per solve over a million puzzles is ten thousand dollars.
    expect(projected1mCostUsd(10_000)).toBe(10_000);
    expect(projected1mHours(0)).toBe(0);
  });
});

const RUN: RunRow = {
  id: "run0123456789abc",
  secret: "never-leaves-the-db",
  harness: "Claude Code",
  config: "opus planner + haiku subagents",
  operator_id: "op0123456789abc",
  dialect: "salt",
  created_at: 1_000,
  last_at: 9_000,
  status: "open",
};

function solve(over: Partial<RunSolveRow>): RunSolveRow {
  return {
    id: 1,
    run_id: RUN.id,
    idx: 0,
    puzzle_key: "L1",
    points: 4,
    bonds: 2,
    probes: 3,
    difficulty: 31,
    wall_ms: 1_000,
    api_calls: 6,
    events: 400,
    tokens_in: 1_000,
    tokens_out: 200,
    cost_micro: 5_000,
    art: FULL_GRID,
    share_id: "abc",
    created_at: 2_000,
    ...over,
  };
}

/*
 * `summarizeRun` and the ranking used to be tested here. Both moved to
 * `server/bench.ts` when the headline metric became effective time per solve,
 * which has to charge a run for the boards it abandoned — and an abandoned
 * board leaves no solve row to read, so the figure cannot be computed from
 * `run_solves` alone. `server/bench.test.ts` covers them now, including the
 * property that matters most: a run with the better median but a pile of
 * dropped boards ranks behind one that ground through everything.
 */

describe("row mapping", () => {
  test("meterToRow keeps unreported as null", () => {
    expect(meterToRow(null)).toEqual({ tokens_in: null, tokens_out: null, cost_micro: null });
    expect(meterToRow({ tokensIn: 1, tokensOut: 2, costMicro: 3 }))
      .toEqual({ tokens_in: 1, tokens_out: 2, cost_micro: 3 });
  });

  test("chartPointOf carries the self-reported nulls through untouched", () => {
    const p = chartPointOf(solve({ cost_micro: null }), RUN);
    expect(p.cost_micro).toBe(null);
    expect(p.harness).toBe("Claude Code");
    expect(p.config).toBe("opus planner + haiku subagents");
    expect(p.wall_ms).toBe(1_000);
  });
});

test("the puzzle universe is the one quoted everywhere", () => {
  expect(PUZZLE_UNIVERSE).toBe(1_000_000);
});
