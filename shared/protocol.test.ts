import { describe, expect, test } from "bun:test";
import { encodeGrid } from "./codec";
import { CELLS, EMPTY, GRID } from "./palette";
import { emptyGrid } from "./rules";
import {
  BLANK_CHAR,
  MAX_LABEL,
  PUZZLE_UNIVERSE,
  RUN_COOKIE,
  chartPointOf,
  clearRunCookie,
  feedbackFrom,
  gridRows,
  isRunId,
  label,
  median,
  meterToRow,
  parseGrid,
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
  { __proto__: { model: "sneaky" } },
];

const OK = { model: "claude-opus-5", provider: "anthropic" };

describe("run identifiers", () => {
  test("accepts only url-safe identifiers of a plausible length", () => {
    expect(isRunId("aB3-_xyz09QWERTy")).toBe(true);
    expect(isRunId("short")).toBe(false);
    expect(isRunId("has spaces here!")).toBe(false);
    expect(isRunId("../../etc/passwd")).toBe(false);
    for (const v of HOSTILE) expect(isRunId(v)).toBe(false);
  });
});

describe("run token extraction", () => {
  const withHeaders = (h: Record<string, string>) =>
    new Request("https://pixe.test/api/bench/runs/abc/next", { headers: h });

  test("reads a bearer token", () => {
    expect(runTokenFrom(withHeaders({ authorization: "Bearer abcdefghijklmnop" })))
      .toBe("abcdefghijklmnop");
  });

  test("reads a real run token, dots and all", () => {
    const tok = "r1.aBcDeFgHiJkL.9x8y7z6w5v4u3t2s1r0q";
    expect(runTokenFrom(withHeaders({ authorization: `Bearer ${tok}` }))).toBe(tok);
    expect(runTokenFrom(withHeaders({ cookie: `${RUN_COOKIE}=${tok}` }))).toBe(tok);
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
  test("takes the declared identity and nothing else", () => {
    const r = parseRegisterRun({ ...OK, config: "8 parallel painters", secret: "ignored" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        model: "claude-opus-5",
        provider: "anthropic",
        config: "8 parallel painters",
      });
    }
  });

  // Both are required rather than optional: a leaderboard grouped on a column
  // that is usually null is not a leaderboard.
  test("refuses a run that will not name a model and a provider", () => {
    expect(parseRegisterRun({ provider: "anthropic" }).ok).toBe(false);
    expect(parseRegisterRun({ model: "claude-opus-5" }).ok).toBe(false);
    expect(parseRegisterRun({ model: "  ", provider: "anthropic" }).ok).toBe(false);
    expect(parseRegisterRun({ model: 7, provider: "anthropic" }).ok).toBe(false);
    expect(parseRegisterRun({ ...OK, model: "a".repeat(MAX_LABEL + 1) }).ok).toBe(false);
  });

  test("config is optional and an absent one is null, not an empty string", () => {
    for (const config of [undefined, null, ""]) {
      const r = parseRegisterRun({ ...OK, config });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.config).toBe(null);
    }
    expect(parseRegisterRun({ ...OK, config: "a".repeat(MAX_LABEL + 1) }).ok).toBe(false);
  });

  // These land straight in a public table, so they are flattened for rendering.
  // Not for truth: nothing here checks that a model is the model it says.
  test("flattens what will be rendered", () => {
    const r = parseRegisterRun({ model: "claude​ opus\n5", provider: "  anthropic  " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ model: "claude opus 5", provider: "anthropic", config: null });
  });

  test("rejects every body that is not a JSON object", () => {
    for (const v of HOSTILE) expect(parseRegisterRun(v).ok).toBe(false);
  });
});

describe("label", () => {
  test("flattens control characters and collapses whitespace", () => {
    expect(label("ev il\n\nagent​")).toBe("ev il agent");
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

/*
 * Three shapes, one grid. Every runner author would otherwise write the same
 * encoder and get it subtly wrong, and a `bad_grid` on a correct answer is the
 * worst possible first impression of a benchmark.
 */
describe("parseGrid", () => {
  const rows = (fill: string) => Array.from({ length: GRID }, () => fill.repeat(GRID));

  test("reads 64 rows of characters", () => {
    const g = parseGrid(rows("a"));
    expect(g).not.toBe(null);
    expect(g!.length).toBe(CELLS);
    expect([...g!].every((v) => v === 0)).toBe(true);
  });

  test("reads 64 rows of integers", () => {
    const g = parseGrid(Array.from({ length: GRID }, () => Array.from({ length: GRID }, () => 3)));
    expect(g).not.toBe(null);
    expect([...g!].every((v) => v === 3)).toBe(true);
  });

  test("reads the run-length string", () => {
    const g = parseGrid(FULL_GRID);
    expect(g).not.toBe(null);
    expect([...g!].every((v) => v === 0)).toBe(true);
  });

  test("blanks survive as blanks in every shape", () => {
    const charRow = BLANK_CHAR + "a".repeat(GRID - 1);
    const chars = parseGrid([charRow, ...rows("a").slice(1)])!;
    expect(chars[0]).toBe(EMPTY);
    expect(chars[1]).toBe(0);

    const nums = Array.from({ length: GRID }, () => Array.from({ length: GRID }, () => 0));
    nums[0]![0] = -1;
    nums[0]![1] = null as unknown as number;
    const parsed = parseGrid(nums)!;
    expect(parsed[0]).toBe(EMPTY);
    expect(parsed[1]).toBe(EMPTY);
    expect(parsed[2]).toBe(0);
  });

  test("all three shapes agree cell for cell", () => {
    const g = emptyGrid();
    for (let i = 0; i < CELLS; i++) g[i] = i % 9 === 8 ? EMPTY : i % 8;
    const asRows = gridRows(g);
    const asNums = asRows.map((row) => [...row].map((c) => (c === BLANK_CHAR ? -1 : c.charCodeAt(0) - 97)));
    expect([...parseGrid(asRows)!]).toEqual([...g]);
    expect([...parseGrid(asNums)!]).toEqual([...g]);
    expect([...parseGrid(encodeGrid(g))!]).toEqual([...g]);
  });

  test("rejects the wrong shape rather than padding it", () => {
    expect(parseGrid(rows("a").slice(1))).toBe(null);
    expect(parseGrid([...rows("a"), "a".repeat(GRID)])).toBe(null);
    expect(parseGrid(rows("a").map((r) => r.slice(1)))).toBe(null);
    expect(parseGrid(rows("z"))).toBe(null);
    expect(parseGrid(rows("A"))).toBe(null);
    expect(parseGrid(Array.from({ length: GRID }, () => Array.from({ length: GRID }, () => 8)))).toBe(null);
    expect(parseGrid(Array.from({ length: GRID }, () => Array.from({ length: GRID }, () => 1.5)))).toBe(null);
    for (const v of HOSTILE) expect(parseGrid(v)).toBe(null);
  });
});

describe("parseSubmit", () => {
  test("accepts a well-formed grid and hands back the decoded board", () => {
    const r = parseSubmit({ grid: FULL_GRID });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.grid.length).toBe(CELLS);
      expect(r.value.meter).toBe(null);
    }
  });

  test("rejects anything the codec cannot read", () => {
    for (const grid of ["", "zzz", "a", "a0", "a-1", "aZZZZZZZZZ", "a1", "%00", "a".repeat(50_000)]) {
      const r = parseSubmit({ grid });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("bad_grid");
    }
    for (const v of HOSTILE) expect(parseSubmit(v).ok).toBe(false);
    expect(parseSubmit({ grid: 12345 }).ok).toBe(false);
    expect(parseSubmit({ grid: { toString: () => FULL_GRID } }).ok).toBe(false);
  });

  test("takes a self-reported meter", () => {
    const r = parseSubmit({ grid: FULL_GRID, meter: { tokensIn: 100, tokensOut: 20, costMicro: 4500 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.meter).toEqual({ tokensIn: 100, tokensOut: 20, costMicro: 4500 });
  });

  test("a partially reported meter keeps its holes", () => {
    const r = parseSubmit({ grid: FULL_GRID, meter: { tokensIn: 100 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.meter).toEqual({ tokensIn: 100, tokensOut: null, costMicro: null });
  });

  test("an entirely empty meter is the same as no meter", () => {
    const r = parseSubmit({ grid: FULL_GRID, meter: {} });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.meter).toBe(null);
  });

  test("rejects the whole float zoo in the meter", () => {
    // `[]` is in here deliberately: Number([]) is 0, so a validator that
    // coerced before type-checking would bank an empty array as a reported zero.
    for (const tokensIn of [-1, 1.5, NaN, Infinity, -Infinity, 1e309, "100", [], {}, 1e13]) {
      expect(parseSubmit({ grid: FULL_GRID, meter: { tokensIn } }).ok).toBe(false);
    }
    expect(parseSubmit({ grid: FULL_GRID, meter: { costMicro: -1 } }).ok).toBe(false);
    expect(parseSubmit({ grid: FULL_GRID, meter: "lots" }).ok).toBe(false);
    expect(parseSubmit({ grid: FULL_GRID, meter: [] }).ok).toBe(false);
  });

  // Reporting is optional, so declining to report has to be a legal submit
  // rather than a malformed body. An explicit null is a run saying "not this
  // one", which is different from a run saying zero.
  test("an explicit null is unreported, not malformed", () => {
    const r = parseSubmit({
      grid: FULL_GRID,
      meter: { tokensIn: null, tokensOut: 40, costMicro: null },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.meter).toEqual({ tokensIn: null, tokensOut: 40, costMicro: null });
  });

  test("a reported zero survives as zero, not as unreported", () => {
    const r = parseSubmit({ grid: FULL_GRID, meter: { tokensIn: 0, tokensOut: 0, costMicro: 0 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.meter).toEqual({ tokensIn: 0, tokensOut: 0, costMicro: 0 });
  });
});

/*
 * The two channels are the entire teaching mechanism, and the wire form is the
 * contract a solver reads: coordinates, and colour names. Neither ever carries
 * a law, a threshold or a direction.
 */
describe("feedback", () => {
  test("cell indices become row-major coordinates", () => {
    const f = feedbackFrom([0, 65, CELLS - 1], []);
    expect(f.flashes).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: GRID - 1, y: GRID - 1 },
    ]);
    expect(f.buzzes).toEqual([]);
  });

  test("hue ids become the names on the palette", () => {
    expect(feedbackFrom([], [4, 0]).buzzes).toEqual(["Tomato", "Mint"]);
  });

  test("reading order, so two responses for one board compare equal", () => {
    const f = feedbackFrom([200, 1, 64], []);
    expect(f.flashes).toEqual([
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 8, y: 3 },
    ]);
  });

  test("a clean board says nothing at all", () => {
    expect(feedbackFrom([], [])).toEqual({ flashes: [], buzzes: [] });
  });
});

describe("the chained sequence", () => {
  // The key derivation itself is server-side and tested in `server/runs.test.ts`.

  // The codec accepts non-canonical encodings, so digesting the client's own
  // string would let a solver re-encode an accepted grid until it liked the
  // next key. Taking a Grid forces the canonical form.
  test("the digest is of the canonical encoding, not the submitted text", async () => {
    const g = emptyGrid();
    g.fill(0);
    const canonical = await solutionDigest(g);
    const reparsed = parseSubmit({ grid: encodeGrid(g) });
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) expect(await solutionDigest(reparsed.value.grid)).toBe(canonical);

    const padded = parseSubmit({ grid: `a1a${(CELLS - 1).toString(36).toUpperCase()}` });
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
  model: "claude-opus-5",
  provider: "anthropic",
  config: "8 parallel painters",
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
    tokens_in: 1_000,
    tokens_out: 200,
    cost_micro: 5_000,
    art: FULL_GRID,
    share_id: "abc",
    created_at: 2_000,
    ...over,
  };
}

describe("row mapping", () => {
  test("meterToRow keeps unreported as null", () => {
    expect(meterToRow(null)).toEqual({ tokens_in: null, tokens_out: null, cost_micro: null });
    expect(meterToRow({ tokensIn: 1, tokensOut: 2, costMicro: 3 }))
      .toEqual({ tokens_in: 1, tokens_out: 2, cost_micro: 3 });
  });

  test("chartPointOf carries the self-reported nulls through untouched", () => {
    const p = chartPointOf(solve({ cost_micro: null }), RUN);
    expect(p.cost_micro).toBe(null);
    expect(p.model).toBe("claude-opus-5");
    expect(p.provider).toBe("anthropic");
    expect(p.config).toBe("8 parallel painters");
    expect(p.wall_ms).toBe(1_000);
  });
});

test("the puzzle universe is the one quoted everywhere", () => {
  expect(PUZZLE_UNIVERSE).toBe(1_000_000);
});
