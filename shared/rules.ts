import { CELLS, EMPTY, GRID, HUE_COUNT, hueName } from "./palette";
import type { ZoneScheme } from "./zones";
import { zoneLabel } from "./zones";

/**
 * Every rule primitive is statically checkable against a finished grid, which
 * is what lets the server re-validate a submission from the seed alone.
 *
 * Rules are keyed by hue and by zone. Per-cell variation comes from zone
 * membership — 4096 independent per-cell rules would be undeducible.
 *
 * Every primitive is also classified into exactly one feedback channel by
 * `ruleChannel`, and that classification is a promise the engine keeps: a law
 * on the cell channel always has guilty cells to flash when it is broken, and a
 * law on the swatch channel always names an implicated colour. Nothing may be
 * broken and invisible at the same time — see `shared/engine.test.ts`.
 */
export type Rule =
  /* ---------------------------------------------------------------- */
  /* Positional                                                        */
  /* ---------------------------------------------------------------- */
  /**
   * This zone accepts only these hues, and every one of them must cover at
   * least `each` cells of it.
   *
   * `each` is what stops the whole game collapsing. Every other primitive is
   * keyed to specific hues, so a player who never paints those hues satisfies
   * all of them vacuously — and a plain permit-list zone rule is perfectly
   * happy with a solid fill. Measured on 150 ladder puzzles: with no floor at
   * all, 96% fell to "one bucket fill per zone"; with a floor of merely one
   * cell per hue, 33% still fell to "solid base plus a token pixel of each
   * other colour", because a hue present once dodges nearly every law about
   * it. Only a real coverage floor forces the rest of the rule set to bite.
   */
  | { t: "zone"; zone: number; hues: number[]; each: number }
  /**
   * Cells handed to the agent already painted, and which must come back
   * unchanged. Only ever present on phase 2+ of a multi-phase rung, where the
   * values are carried over from the agent's own accepted grid for the phase
   * before. Stated information rather than a hidden law — it is listed in the
   * puzzle payload — so it is worth no points, but it is still evaluated here
   * because it is still a condition on an accepted grid.
   */
  | { t: "locked"; cells: { i: number; h: number }[] }
  /** A and B may never share an orthogonal edge. */
  | { t: "forbidAdj"; a: number; b: number }
  /** Every A needs at least one orthogonal B. */
  | { t: "requireAdj"; a: number; b: number }
  /** A covers at most `max` cells. */
  | { t: "quotaMax"; a: number; max: number }
  /** A covers at least `min` cells. */
  | { t: "quotaMin"; a: number; min: number }
  /** A only sits where (x + y) % 2 === p. */
  | { t: "parity"; a: number; p: number }
  /** A never fills a solid 2x2 block. */
  | { t: "noBlock"; a: number }
  /** At most `max` A per row (or column). */
  | { t: "lineLimit"; a: number; axis: "row" | "col"; max: number }
  /** Every A has at least one orthogonal A. */
  | { t: "buddy"; a: number }
  /** No two A are orthogonally adjacent. */
  | { t: "lonely"; a: number }
  /** A must stay inside / outside the outer `d` cells. */
  | { t: "border"; a: number; mode: "only" | "never"; d: number }
  /** A and B keep at least one empty-of-each-other cell between them. */
  | { t: "farApart"; a: number; b: number }

  /* ---------------------------------------------------------------- */
  /* Coordinate arithmetic — laws about where a cell *is*, arithmetically */
  /* ---------------------------------------------------------------- */
  /**
   * A never stands on a cell whose (x × y) is congruent to `r` modulo `k`.
   *
   * The nastiest family in the set, because the forbidden cells form no visible
   * shape at all: the multiplication table mod k scatters them across the board
   * in a pattern with no local structure. An agent cannot see it by looking at
   * where the flashes are; it has to hypothesise arithmetic and test it.
   */
  | { t: "product"; a: number; k: number; r: number }
  /**
   * A only stands where a linear index is congruent to `r` modulo `k`:
   * `sum` = x + y, `diff` = x − y, `x`, `y`. `parity` is the k = 2 sum case,
   * kept separate because it is the one an agent guesses first.
   */
  | { t: "lattice"; a: number; axis: "sum" | "diff" | "x" | "y"; k: number; r: number }

  /* ---------------------------------------------------------------- */
  /* Extended adjacency geometry                                       */
  /* ---------------------------------------------------------------- */
  /** No two A stand a knight's move apart. */
  | { t: "knight"; a: number }
  /** At most `max` A inside any (2r+1)×(2r+1) window. A local density cap. */
  | { t: "boxCap"; a: number; r: number; max: number }

  /* ---------------------------------------------------------------- */
  /* Runs                                                              */
  /* ---------------------------------------------------------------- */
  /** No unbroken run of A along `axis` is longer than `max`. */
  | { t: "runCap"; a: number; axis: "row" | "col"; max: number }
  /** Every completed run of A along `axis` has a length divisible by `m`. */
  | { t: "runMod"; a: number; axis: "row" | "col"; m: number }

  /* ---------------------------------------------------------------- */
  /* Connectivity                                                      */
  /* ---------------------------------------------------------------- */
  /** Every A can walk to the frame through A cells, orthogonally. */
  | { t: "reach"; a: number }
  /** A forms exactly `k` orthogonally connected regions. */
  | { t: "regions"; a: number; k: number }

  /* ---------------------------------------------------------------- */
  /* Symmetry                                                          */
  /* ---------------------------------------------------------------- */
  /** The set of A cells is invariant under `op`. */
  | { t: "mirror"; a: number; op: "rot180" | "flipX" | "flipY" | "transpose" }

  /* ---------------------------------------------------------------- */
  /* Conditional                                                       */
  /* ---------------------------------------------------------------- */
  /** No single row (or column) contains both A and B. */
  | { t: "exclusive"; a: number; b: number; axis: "row" | "col" }

  /* ---------------------------------------------------------------- */
  /* Relational and positional counting                                */
  /* ---------------------------------------------------------------- */
  /** count(A) ≥ (tenths/10) × count(B), or ≤. A ratio between two colours. */
  | { t: "relCount"; a: number; b: number; tenths: number; cmp: "atLeast" | "atMost" }
  /** A's count in half `heavy` beats its count in the other half by ≥ `margin`. */
  | { t: "halfTilt"; a: number; axis: "h" | "v"; heavy: 0 | 1; margin: number }
  /** A covers at least / at most `n` cells of zone `zone`. */
  | { t: "zoneCount"; a: number; zone: number; cmp: "atLeast" | "atMost"; n: number }
  /** count(A) ≡ r (mod m). Pure arithmetic on a total nobody is told. */
  | { t: "countMod"; a: number; m: number; r: number };

export type RuleKind = Rule["t"];

/** A pair of hues that score bonus "bond" points when they touch. Not a constraint. */
export interface Bond {
  a: number;
  b: number;
}

export type Grid = Int8Array;

export function emptyGrid(): Grid {
  const g = new Int8Array(CELLS);
  g.fill(EMPTY);
  return g;
}

export interface EvalCtx {
  zmap: Uint8Array;
  counts: Int32Array;
  empties: number;
}

export function makeCtx(grid: Grid, zmap: Uint8Array): EvalCtx {
  const counts = new Int32Array(HUE_COUNT);
  let empties = 0;
  for (let i = 0; i < CELLS; i++) {
    const v = grid[i]!;
    if (v < 0) empties++;
    else counts[v]!++;
  }
  return { zmap, counts, empties };
}

export interface RuleEval {
  /** `broken` = definitely wrong now. `pending` = not satisfied but still reachable. */
  status: "ok" | "pending" | "broken";
  /** Cell indices to highlight. */
  violations: number[];
  /** Has the player done anything that this rule could plausibly be about? */
  touched: boolean;
  /**
   * Counting rules have no single guilty cell to glow, so they signal through
   * the hue's palette swatch instead. Without this a full grid failing only a
   * `quotaMin` would show the player nothing at all — an unwinnable dead end,
   * since the game never narrates its rules.
   */
  hue: number | null;
  /**
   * Extra implicated colours, for laws that relate two of them. `hue` alone
   * would under-report a ratio law: "Mint is unhappy" is a different and less
   * honest statement than "Mint and Grape are unhappy together".
   */
  hues?: number[];
  /** Drives the swatch's reaction intensity. Never rendered as a number. */
  progress: { have: number; need: number; dir: "atLeast" | "atMost" } | null;
}

/** Every colour a verdict implicates, primary and secondary alike. */
export function buzzedHues(ev: RuleEval): number[] {
  if (ev.hue === null) return ev.hues ?? [];
  return ev.hues ? [ev.hue, ...ev.hues] : [ev.hue];
}

/**
 * Which feedback channel a law speaks through when it is broken.
 *
 * `cell` laws are about where a cell is or what it touches, so there is always
 * something to flash. `swatch` laws are about how many of something there are,
 * so there is never a single guilty cell and the colour's swatch carries the
 * complaint instead. `both` is for laws that can fail either way.
 *
 * This is not documentation. `shared/engine.test.ts` asserts that a broken
 * verdict always produces feedback on the channel claimed here, for every
 * primitive, which is what makes "no failing law is invisible" mechanical.
 */
export function ruleChannel(r: Rule): "cell" | "swatch" | "both" {
  switch (r.t) {
    case "zone":
    case "lineLimit":
      return "both";
    case "quotaMax":
    case "quotaMin":
    case "regions":
    case "relCount":
    case "halfTilt":
    case "zoneCount":
    case "countMod":
      return "swatch";
    default:
      return "cell";
  }
}

const OK: RuleEval = { status: "ok", violations: [], touched: false, hue: null, progress: null };

function ok(touched: boolean, progress: RuleEval["progress"] = null, hue: number | null = null): RuleEval {
  return touched || progress ? { status: "ok", violations: [], touched, hue, progress } : OK;
}

const broken = (violations: number[], hue: number | null = null, extra?: number[]): RuleEval => ({
  status: "broken",
  violations,
  touched: true,
  hue,
  ...(extra ? { hues: extra } : {}),
  progress: null,
});

const pending = (touched: boolean, hue: number | null = null, progress: RuleEval["progress"] = null): RuleEval => ({
  status: "pending",
  violations: [],
  touched,
  hue,
  progress,
});

export function evaluateRule(rule: Rule, grid: Grid, ctx: EvalCtx): RuleEval {
  switch (rule.t) {
    case "zone": {
      const allowed = new Uint8Array(HUE_COUNT);
      for (const h of rule.hues) allowed[h] = 1;
      const seen = new Int32Array(HUE_COUNT);
      const violations: number[] = [];
      let touched = false;
      let empties = 0;
      for (let i = 0; i < CELLS; i++) {
        if (ctx.zmap[i] !== rule.zone) continue;
        const v = grid[i]!;
        if (v < 0) {
          empties++;
          continue;
        }
        touched = true;
        if (!allowed[v]) violations.push(i);
        else seen[v]!++;
      }
      // A hue that doesn't belong here is the more specific complaint, so it
      // wins the glow when both are wrong at once.
      if (violations.length) return broken(violations);
      // How many more cells this zone still owes, summed over every hue that
      // is short of its floor. The scarcest listed hue is the one to point at.
      let shortfall = 0;
      let worst = -1;
      for (const h of rule.hues) {
        shortfall += Math.max(0, rule.each - seen[h]!);
        if (worst < 0 || seen[h]! < seen[worst]!) worst = h;
      }
      if (shortfall === 0) return ok(touched);
      // Still enough blank space for the debt to be paid — say nothing yet.
      // The complaint lands the instant the zone fills up, which is exactly
      // when the lesson is legible.
      if (shortfall <= empties) return pending(touched);
      // No single guilty cell, so the region itself is the message and the
      // whole zone glows. It also names the scarcest hue through the swatch,
      // with `progress` so the buzz eases off as that colour gains ground.
      //
      // Without the gradient this is a cliff: a player adding 50, then 100,
      // then 150 cells of the missing colour would see no change at all until
      // the threshold snapped, and "adding paint changes nothing" is exactly
      // the signal that says stop pulling this lever. A rule you cannot get
      // warmer or colder on is not learnable by exploration.
      const zoneCells: number[] = [];
      for (let i = 0; i < CELLS; i++) if (ctx.zmap[i] === rule.zone) zoneCells.push(i);
      return {
        status: "broken",
        violations: zoneCells,
        touched: true,
        hue: worst,
        progress: { have: seen[worst]!, need: rule.each, dir: "atLeast" },
      };
    }

    case "locked": {
      const violations: number[] = [];
      let blanks = false;
      for (const { i, h } of rule.cells) {
        const v = grid[i]!;
        if (v === EMPTY) blanks = true;
        else if (v !== h) violations.push(i);
      }
      if (violations.length) return broken(violations);
      if (blanks) return pending(true);
      return ok(rule.cells.length > 0);
    }

    case "forbidAdj": {
      const { a, b } = rule;
      const violations: number[] = [];
      for (let i = 0; i < CELLS; i++) {
        const v = grid[i]!;
        if (v !== a && v !== b) continue;
        const other = v === a ? b : a;
        const x = i % GRID;
        if (x < GRID - 1 && grid[i + 1] === other) violations.push(i, i + 1);
        if (i + GRID < CELLS && grid[i + GRID] === other) violations.push(i, i + GRID);
      }
      const touched = ctx.counts[a]! > 0 || ctx.counts[b]! > 0;
      return violations.length ? broken(dedupe(violations)) : ok(touched);
    }

    case "farApart": {
      const { a, b } = rule;
      const violations: number[] = [];
      for (let i = 0; i < CELLS; i++) {
        if (grid[i] !== a) continue;
        const x = i % GRID;
        const y = (i / GRID) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
            const j = ny * GRID + nx;
            if (grid[j] === b) violations.push(i, j);
          }
        }
      }
      const touched = ctx.counts[a]! > 0 || ctx.counts[b]! > 0;
      return violations.length ? broken(dedupe(violations)) : ok(touched);
    }

    case "requireAdj": {
      const { a, b } = rule;
      const violations: number[] = [];
      let unsettled = false;
      for (let i = 0; i < CELLS; i++) {
        if (grid[i] !== a) continue;
        let hasB = false;
        let hasEmpty = false;
        forEachNeighbor(i, (j) => {
          const v = grid[j]!;
          if (v === b) hasB = true;
          else if (v === EMPTY) hasEmpty = true;
        });
        if (hasB) continue;
        if (hasEmpty) unsettled = true;
        else violations.push(i);
      }
      const touched = ctx.counts[a]! > 0;
      if (violations.length) return broken(violations);
      if (unsettled) return pending(true);
      return ok(touched);
    }

    case "buddy": {
      const { a } = rule;
      const violations: number[] = [];
      let unsettled = false;
      for (let i = 0; i < CELLS; i++) {
        if (grid[i] !== a) continue;
        let hasA = false;
        let hasEmpty = false;
        forEachNeighbor(i, (j) => {
          const v = grid[j]!;
          if (v === a) hasA = true;
          else if (v === EMPTY) hasEmpty = true;
        });
        if (hasA) continue;
        if (hasEmpty) unsettled = true;
        else violations.push(i);
      }
      const touched = ctx.counts[a]! > 0;
      if (violations.length) return broken(violations);
      if (unsettled) return pending(true);
      return ok(touched);
    }

    case "lonely": {
      const { a } = rule;
      const violations: number[] = [];
      for (let i = 0; i < CELLS; i++) {
        if (grid[i] !== a) continue;
        const x = i % GRID;
        if (x < GRID - 1 && grid[i + 1] === a) violations.push(i, i + 1);
        if (i + GRID < CELLS && grid[i + GRID] === a) violations.push(i, i + GRID);
      }
      const touched = ctx.counts[a]! > 0;
      return violations.length ? broken(dedupe(violations)) : ok(touched);
    }

    case "parity": {
      const { a, p } = rule;
      const violations: number[] = [];
      for (let i = 0; i < CELLS; i++) {
        if (grid[i] !== a) continue;
        if ((((i % GRID) + ((i / GRID) | 0)) & 1) !== p) violations.push(i);
      }
      const touched = ctx.counts[a]! > 0;
      return violations.length ? broken(violations) : ok(touched);
    }

    case "noBlock": {
      const { a } = rule;
      const violations: number[] = [];
      for (let y = 0; y < GRID - 1; y++) {
        for (let x = 0; x < GRID - 1; x++) {
          const i = y * GRID + x;
          if (grid[i] === a && grid[i + 1] === a && grid[i + GRID] === a && grid[i + GRID + 1] === a) {
            violations.push(i, i + 1, i + GRID, i + GRID + 1);
          }
        }
      }
      const touched = ctx.counts[a]! > 0;
      return violations.length ? broken(dedupe(violations)) : ok(touched);
    }

    case "lineLimit": {
      const { a, axis, max } = rule;
      const tally = new Int32Array(GRID);
      for (let i = 0; i < CELLS; i++) {
        if (grid[i] !== a) continue;
        tally[axis === "row" ? (i / GRID) | 0 : i % GRID]!++;
      }
      let worst = 0;
      const bad = new Uint8Array(GRID);
      for (let l = 0; l < GRID; l++) {
        worst = Math.max(worst, tally[l]!);
        if (tally[l]! > max) bad[l] = 1;
      }
      const violations: number[] = [];
      if (worst > max) {
        for (let i = 0; i < CELLS; i++) {
          if (grid[i] !== a) continue;
          if (bad[axis === "row" ? (i / GRID) | 0 : i % GRID]) violations.push(i);
        }
      }
      const touched = ctx.counts[a]! > 0;
      const progress = { have: worst, need: max, dir: "atMost" as const };
      // Offending rows/columns are precise enough to glow, and the swatch
      // reacts too so the player can tell it apart from a placement rule.
      return violations.length
        ? { status: "broken", violations, touched: true, hue: a, progress }
        : ok(touched, progress);
    }

    case "border": {
      const { a, mode, d } = rule;
      const violations: number[] = [];
      for (let i = 0; i < CELLS; i++) {
        if (grid[i] !== a) continue;
        const x = i % GRID;
        const y = (i / GRID) | 0;
        const inBand = Math.min(x, y, GRID - 1 - x, GRID - 1 - y) < d;
        if (mode === "never" ? inBand : !inBand) violations.push(i);
      }
      const touched = ctx.counts[a]! > 0;
      return violations.length ? broken(violations) : ok(touched);
    }

    case "quotaMax": {
      const { a, max } = rule;
      const have = ctx.counts[a]!;
      const progress = { have, need: max, dir: "atMost" as const };
      if (have <= max) return ok(have > 0, progress);
      // Lighting up every cell of an overused hue would set the whole canvas
      // on fire and say nothing useful. The swatch carries this one alone.
      return { status: "broken", violations: [], touched: true, hue: a, progress };
    }

    case "quotaMin": {
      const { a, min } = rule;
      const have = ctx.counts[a]!;
      const progress = { have, need: min, dir: "atLeast" as const };
      if (have >= min) return ok(true, progress, a);
      // Unreachable even if every remaining empty cell became A.
      if (have + ctx.empties < min) {
        return { status: "broken", violations: [], touched: true, hue: a, progress };
      }
      return pending(have > 0, a, progress);
    }

    /* ---------------------------------------------------------------- */
    /* Coordinate arithmetic                                             */
    /* ---------------------------------------------------------------- */

    case "product": {
      const { a, k, r } = rule;
      const violations: number[] = [];
      for (let i = 0; i < CELLS; i++) {
        if (grid[i] !== a) continue;
        if (((i % GRID) * ((i / GRID) | 0)) % k === r) violations.push(i);
      }
      return violations.length ? broken(violations) : ok(ctx.counts[a]! > 0);
    }

    case "lattice": {
      const { a, axis, k, r } = rule;
      const violations: number[] = [];
      for (let i = 0; i < CELLS; i++) {
        if (grid[i] !== a) continue;
        if (latticeIndex(axis, i % GRID, (i / GRID) | 0) % k !== r) violations.push(i);
      }
      return violations.length ? broken(violations) : ok(ctx.counts[a]! > 0);
    }

    /* ---------------------------------------------------------------- */
    /* Extended adjacency geometry                                       */
    /* ---------------------------------------------------------------- */

    case "knight": {
      const { a } = rule;
      const violations: number[] = [];
      // Half the eight knight vectors: each unordered pair is seen exactly once.
      const moves: [number, number][] = [[1, 2], [2, 1], [2, -1], [1, -2]];
      for (let i = 0; i < CELLS; i++) {
        if (grid[i] !== a) continue;
        const x = i % GRID;
        const y = (i / GRID) | 0;
        for (const [dx, dy] of moves) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
          const j = ny * GRID + nx;
          if (grid[j] === a) violations.push(i, j);
        }
      }
      return violations.length ? broken(dedupe(violations)) : ok(ctx.counts[a]! > 0);
    }

    case "boxCap": {
      const { a, r, max } = rule;
      // Summed-area table, so the window sweep is O(cells) rather than
      // O(cells × window). At r = 2 the naive form is 25× the work and this
      // primitive is evaluated on every probe.
      const w = GRID + 1;
      const sum = new Int32Array(w * w);
      for (let y = 0; y < GRID; y++) {
        for (let x = 0; x < GRID; x++) {
          sum[(y + 1) * w + x + 1] =
            (grid[y * GRID + x] === a ? 1 : 0) +
            sum[y * w + x + 1]! + sum[(y + 1) * w + x]! - sum[y * w + x]!;
        }
      }
      const side = 2 * r + 1;
      const bad: number[] = [];
      for (let y = 0; y + side <= GRID; y++) {
        for (let x = 0; x + side <= GRID; x++) {
          const n =
            sum[(y + side) * w + x + side]! - sum[y * w + x + side]! -
            sum[(y + side) * w + x]! + sum[y * w + x]!;
          if (n <= max) continue;
          for (let dy = 0; dy < side; dy++) {
            for (let dx = 0; dx < side; dx++) {
              const j = (y + dy) * GRID + x + dx;
              if (grid[j] === a) bad.push(j);
            }
          }
        }
      }
      return bad.length ? broken(dedupe(bad)) : ok(ctx.counts[a]! > 0);
    }

    /* ---------------------------------------------------------------- */
    /* Runs                                                              */
    /* ---------------------------------------------------------------- */

    case "runCap": {
      const { a, axis, max } = rule;
      const violations: number[] = [];
      // A contiguous block of A longer than the cap is wrong no matter what
      // fills the rest of the board, so there is no pending state here.
      forEachRun(grid, a, axis, (cells, sealed) => {
        void sealed;
        if (cells.length > max) violations.push(...cells);
      });
      return violations.length ? broken(violations) : ok(ctx.counts[a]! > 0);
    }

    case "runMod": {
      const { a, axis, m } = rule;
      const violations: number[] = [];
      let unsettled = false;
      forEachRun(grid, a, axis, (cells, sealed) => {
        // A run with a blank at either end is still growing: judging it now
        // would be nagging about a length the agent has not committed to.
        if (!sealed) unsettled = true;
        else if (cells.length % m !== 0) violations.push(...cells);
      });
      if (violations.length) return broken(violations);
      if (unsettled) return pending(true);
      return ok(ctx.counts[a]! > 0);
    }

    /* ---------------------------------------------------------------- */
    /* Connectivity                                                      */
    /* ---------------------------------------------------------------- */

    case "reach": {
      const { a } = rule;
      const comps = components(grid, a);
      const violations: number[] = [];
      let unsettled = false;
      for (const c of comps) {
        if (c.touchesBorder) continue;
        // An island next to blank space can still grow a bridge to the frame.
        if (c.touchesEmpty) unsettled = true;
        else violations.push(...c.cells);
      }
      if (violations.length) return broken(violations);
      if (unsettled) return pending(true);
      return ok(ctx.counts[a]! > 0);
    }

    case "regions": {
      const { a, k } = rule;
      const comps = components(grid, a);
      const progress = { have: comps.length, need: k, dir: "atMost" as const };
      if (ctx.empties === 0) {
        return comps.length === k
          ? ok(true, progress, a)
          : { status: "broken", violations: [], touched: true, hue: a, progress };
      }
      // Sealed islands can never merge into each other, so more of them than
      // the law allows is already decided. Everything else is still open.
      let sealed = 0;
      for (const c of comps) if (!c.touchesEmpty) sealed++;
      if (sealed > k) {
        return { status: "broken", violations: [], touched: true, hue: a, progress };
      }
      return pending(ctx.counts[a]! > 0, a, progress);
    }

    /* ---------------------------------------------------------------- */
    /* Symmetry                                                          */
    /* ---------------------------------------------------------------- */

    case "mirror": {
      const { a, op } = rule;
      const violations: number[] = [];
      let unsettled = false;
      for (let i = 0; i < CELLS; i++) {
        if (grid[i] !== a) continue;
        const j = reflect(op, i);
        const v = grid[j]!;
        if (v === a) continue;
        if (v === EMPTY) unsettled = true;
        else violations.push(i, j);
      }
      if (violations.length) return broken(dedupe(violations));
      if (unsettled) return pending(true);
      return ok(ctx.counts[a]! > 0);
    }

    /* ---------------------------------------------------------------- */
    /* Conditional                                                       */
    /* ---------------------------------------------------------------- */

    case "exclusive": {
      const { a, b, axis } = rule;
      const hasA = new Uint8Array(GRID);
      const hasB = new Uint8Array(GRID);
      for (let i = 0; i < CELLS; i++) {
        const v = grid[i]!;
        if (v !== a && v !== b) continue;
        const line = axis === "row" ? (i / GRID) | 0 : i % GRID;
        if (v === a) hasA[line] = 1;
        else hasB[line] = 1;
      }
      let clash = false;
      for (let l = 0; l < GRID; l++) if (hasA[l] && hasB[l]) clash = true;
      if (!clash) return ok(ctx.counts[a]! > 0 || ctx.counts[b]! > 0);
      const violations: number[] = [];
      for (let i = 0; i < CELLS; i++) {
        const v = grid[i]!;
        if (v !== a && v !== b) continue;
        const line = axis === "row" ? (i / GRID) | 0 : i % GRID;
        if (hasA[line] && hasB[line]) violations.push(i);
      }
      return broken(violations);
    }

    /* ---------------------------------------------------------------- */
    /* Relational and positional counting                                */
    /* ---------------------------------------------------------------- */

    case "relCount": {
      const { a, b, tenths, cmp } = rule;
      const ca = ctx.counts[a]!;
      const cb = ctx.counts[b]!;
      const progress = { have: ca * 10, need: tenths * cb, dir: cmp };
      const held = cmp === "atLeast" ? ca * 10 >= tenths * cb : ca * 10 <= tenths * cb;
      if (held) return { status: "ok", violations: [], touched: true, hue: a, hues: [b], progress };
      // Best case for the law: every blank cell goes to whichever of the two
      // colours helps. If even that misses, the grid is already decided.
      const best =
        cmp === "atLeast"
          ? (ca + ctx.empties) * 10 >= tenths * cb
          : ca * 10 <= tenths * (cb + ctx.empties);
      if (!best) {
        return { status: "broken", violations: [], touched: true, hue: a, hues: [b], progress };
      }
      return { status: "pending", violations: [], touched: true, hue: a, hues: [b], progress };
    }

    case "halfTilt": {
      const { a, axis, heavy, margin } = rule;
      const have = new Int32Array(2);
      const room = new Int32Array(2);
      for (let i = 0; i < CELLS; i++) {
        const side = (axis === "h" ? (i / GRID) | 0 : i % GRID) < GRID / 2 ? 0 : 1;
        const v = grid[i]!;
        if (v === a) have[side]!++;
        else if (v === EMPTY) room[side]!++;
      }
      const other = heavy === 0 ? 1 : 0;
      const diff = have[heavy]! - have[other]!;
      const progress = { have: diff, need: margin, dir: "atLeast" as const };
      if (diff >= margin) return ok(true, progress, a);
      if (diff + room[heavy]! < margin) {
        return { status: "broken", violations: [], touched: true, hue: a, progress };
      }
      return pending(ctx.counts[a]! > 0, a, progress);
    }

    case "zoneCount": {
      const { a, zone, cmp, n } = rule;
      let have = 0;
      let room = 0;
      for (let i = 0; i < CELLS; i++) {
        if (ctx.zmap[i] !== zone) continue;
        const v = grid[i]!;
        if (v === a) have++;
        else if (v === EMPTY) room++;
      }
      const progress = { have, need: n, dir: cmp };
      if (cmp === "atMost") {
        return have <= n
          ? ok(true, progress, a)
          : { status: "broken", violations: [], touched: true, hue: a, progress };
      }
      if (have >= n) return ok(true, progress, a);
      if (have + room < n) {
        return { status: "broken", violations: [], touched: true, hue: a, progress };
      }
      return pending(have > 0, a, progress);
    }

    case "countMod": {
      const { a, m, r } = rule;
      const have = ctx.counts[a]!;
      const progress = { have: have % m, need: r, dir: "atLeast" as const };
      if (have % m === r) return ok(true, progress, a);
      // How many more cells of A it would take to land on the residue. Any
      // blank cell can become one, so this is reachable while that many remain.
      const need = (((r - have) % m) + m) % m;
      if (need > ctx.empties) {
        return { status: "broken", violations: [], touched: true, hue: a, progress };
      }
      return pending(have > 0, a, progress);
    }
  }
}

function dedupe(a: number[]): number[] {
  return a.length > 1 ? [...new Set(a)] : a;
}

function forEachNeighbor(i: number, fn: (j: number) => void): void {
  const x = i % GRID;
  if (x > 0) fn(i - 1);
  if (x < GRID - 1) fn(i + 1);
  if (i >= GRID) fn(i - GRID);
  if (i + GRID < CELLS) fn(i + GRID);
}

export function latticeIndex(axis: "sum" | "diff" | "x" | "y", x: number, y: number): number {
  switch (axis) {
    case "sum":
      return x + y;
    // Offset so the value is never negative and `%` behaves like a residue.
    case "diff":
      return x - y + GRID;
    case "x":
      return x;
    case "y":
      return y;
  }
}

/** The involutions a `mirror` law may be stated over. All are self-inverse. */
export function reflect(op: "rot180" | "flipX" | "flipY" | "transpose", i: number): number {
  const x = i % GRID;
  const y = (i / GRID) | 0;
  switch (op) {
    case "rot180":
      return (GRID - 1 - y) * GRID + (GRID - 1 - x);
    case "flipX":
      return y * GRID + (GRID - 1 - x);
    case "flipY":
      return (GRID - 1 - y) * GRID + x;
    case "transpose":
      return x * GRID + y;
  }
}

/**
 * Every maximal run of `a` along one axis, with whether both of its ends are
 * settled — that is, the grid edge or a cell already painted something else.
 * An unsealed run is one a blank could still extend, which is the difference
 * between "this run is the wrong length" and "this run is not finished".
 */
export function forEachRun(
  grid: Grid,
  a: number,
  axis: "row" | "col",
  fn: (cells: number[], sealed: boolean) => void,
): void {
  const at = axis === "row" ? (l: number, k: number) => l * GRID + k : (l: number, k: number) => k * GRID + l;
  for (let l = 0; l < GRID; l++) {
    let k = 0;
    while (k < GRID) {
      if (grid[at(l, k)] !== a) {
        k++;
        continue;
      }
      const start = k;
      const cells: number[] = [];
      while (k < GRID && grid[at(l, k)] === a) {
        cells.push(at(l, k));
        k++;
      }
      const before = start === 0 ? -1 : grid[at(l, start - 1)]!;
      const after = k === GRID ? -1 : grid[at(l, k)]!;
      const sealed = (start === 0 || before !== EMPTY) && (k === GRID || after !== EMPTY);
      fn(cells, sealed);
    }
  }
}

export interface Component {
  cells: number[];
  touchesBorder: boolean;
  touchesEmpty: boolean;
}

/** Orthogonally connected components of one hue, flood-filled iteratively. */
export function components(grid: Grid, a: number): Component[] {
  const seen = new Uint8Array(CELLS);
  const out: Component[] = [];
  const stack: number[] = [];
  for (let s = 0; s < CELLS; s++) {
    if (seen[s] || grid[s] !== a) continue;
    const cells: number[] = [];
    let touchesBorder = false;
    let touchesEmpty = false;
    seen[s] = 1;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      cells.push(i);
      const x = i % GRID;
      const y = (i / GRID) | 0;
      if (x === 0 || y === 0 || x === GRID - 1 || y === GRID - 1) touchesBorder = true;
      forEachNeighbor(i, (j) => {
        const v = grid[j]!;
        if (v === EMPTY) touchesEmpty = true;
        else if (v === a && !seen[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      });
    }
    out.push({ cells, touchesBorder, touchesEmpty });
  }
  return out;
}

/**
 * How much a rule contributes to a puzzle's difficulty score.
 *
 * The scale is "how many hypotheses does an agent have to eliminate before it
 * can state this law". The classic adjacency and quota family sits at 1.4-2.6,
 * because a solver that has seen a flash next to a colour pair has a small
 * space to search. The new families sit higher because their evidence is
 * consistent with far more hypotheses: a `product` flash looks like noise until
 * you think to try arithmetic, and a `countMod` never flashes at all.
 */
export function ruleWeight(r: Rule): number {
  switch (r.t) {
    case "zone":
      // Narrow palettes bite harder. The coverage floor adds a little on top,
      // flattened by a log so a zone demanding 200 cells of each hue is not
      // scored as ten times harder than one demanding 20.
      return 1 + Math.max(0, 4 - r.hues.length) * 0.4 + Math.log2(1 + r.each) * 0.25;
    // Pre-filled cells are stated in the payload, not deduced. They constrain
    // the answer, but paying points for information the agent was handed would
    // make a later phase look harder than it is.
    case "locked":
      return 0;
    case "forbidAdj":
      return 1.6;
    case "requireAdj":
      return 2.4;
    case "farApart":
      return 2.6;
    case "quotaMax":
      return 1.5;
    case "quotaMin":
      return 1.7;
    case "parity":
      return 2.2;
    case "noBlock":
      return 1.4;
    case "lineLimit":
      return 1.8;
    case "buddy":
      return 1.9;
    case "lonely":
      return 2.5;
    case "border":
      return 1.5;

    // The forbidden set has no local structure at all — the multiplication
    // table mod k scatters it — so the flashes read as noise until an agent
    // thinks to test arithmetic. The largest single jump in the set.
    case "product":
      return 3.6 + (r.k - 3) * 0.15;
    // A modular stripe. k = 2 is `parity`, which sits at 2.2; every extra
    // residue is another hypothesis to eliminate, and the diagonal axes are
    // harder to see than the axis-aligned ones.
    case "lattice":
      return 2.0 + r.k * 0.35 + (r.axis === "sum" || r.axis === "diff" ? 0.3 : 0);
    // Non-adjacent by construction, so the evidence never appears next to
    // itself; an agent must notice a distance rather than a contact.
    case "knight":
      return 3.2;
    // A density ceiling reads like a quota until you notice it is local.
    case "boxCap":
      return 2.6 + r.r * 0.2;
    case "runCap":
      return 2.0;
    // Length parity is invisible in any single cell and only ever legible
    // across a whole run, which no flash points at directly.
    case "runMod":
      return 3.4 + (r.m - 2) * 0.3;
    case "reach":
      return 2.8;
    // Global topology reported through a swatch and nothing else: the agent is
    // told a colour is unhappy and must work out that the complaint is shape.
    case "regions":
      return 3.4;
    // A whole-board involution. Cheap to verify once guessed, expensive to guess.
    case "mirror":
      return 3.8;
    case "exclusive":
      return 2.6;
    // Two colours implicated at once, and the law is about neither of them
    // separately.
    case "relCount":
      return 3.0;
    case "halfTilt":
      return 2.4;
    case "zoneCount":
      return 2.0;
    // The hardest thing in the set to observe: a residue class of a total the
    // agent is never told, on a channel that carries one bit.
    case "countMod":
      return 4.0 + (r.m - 2) * 0.4;
  }
}

const N = hueName;

/**
 * Plain-English rule text. This is NEVER shown while a puzzle is in progress —
 * the game teaches only by making offending cells glow. It is used for the
 * post-solve reveal and the share page, where it can no longer help you.
 */
export function ruleText(r: Rule, scheme: ZoneScheme): string {
  switch (r.t) {
    case "zone": {
      const names = list(r.hues.map((h) => N(h)));
      const where = cap(zoneLabel(scheme, r.zone));
      if (r.each <= 0) return `${where} only accepts ${names}.`;
      if (r.each === 1) return `${where} only accepts ${names}, and all of them must show up.`;
      return `${where} only accepts ${names}, and each of them must cover at least ${r.each} cells of it.`;
    }
    case "locked":
      return `${r.cells.length} cells were carried over from the previous phase and had to come back untouched.`;
    case "forbidAdj":
      return `${N(r.a)} refuses to share an edge with ${N(r.b)}. Corners are fine — they can be civil at a distance.`;
    case "requireAdj":
      return `Every ${N(r.a)} needs at least one ${N(r.b)} beside it or it gets lonely.`;
    case "farApart":
      return `${N(r.a)} and ${N(r.b)} are exes. Keep at least one cell between them, diagonals included.`;
    case "quotaMax":
      return `${N(r.a)} may cover at most ${r.max} cells.`;
    case "quotaMin":
      return `${N(r.a)} must cover at least ${r.min} cells.`;
    case "parity":
      return `${N(r.a)} only stands on the ${r.p === 0 ? "even" : "odd"} squares of the checkerboard (x + y is ${r.p === 0 ? "even" : "odd"}).`;
    case "noBlock":
      return `${N(r.a)} never clumps into a solid 2×2 block.`;
    case "lineLimit":
      return `At most ${r.max} ${N(r.a)} per ${r.axis === "row" ? "row" : "column"}.`;
    case "buddy":
      return `${N(r.a)} travels in packs — every ${N(r.a)} needs another ${N(r.a)} orthogonally beside it.`;
    case "lonely":
      return `${N(r.a)} is a loner — no two ${N(r.a)} may share an edge.`;
    case "border":
      return r.mode === "never"
        ? `${N(r.a)} is scared of heights — it stays out of the outer ${r.d} cell${r.d > 1 ? "s" : ""} of the grid.`
        : `${N(r.a)} clings to the frame — it only appears in the outer ${r.d} cell${r.d > 1 ? "s" : ""}.`;
    case "product":
      return `${N(r.a)} never stands on a cell where x × y leaves remainder ${r.r} when divided by ${r.k}.`;
    case "lattice": {
      const expr = { sum: "x + y", diff: "x − y", x: "x", y: "y" }[r.axis];
      return `${N(r.a)} only stands where ${expr} leaves remainder ${r.r} when divided by ${r.k}.`;
    }
    case "knight":
      return `No two ${N(r.a)} stand a knight's move apart — two along and one across, in any direction.`;
    case "boxCap":
      return `No ${2 * r.r + 1}×${2 * r.r + 1} window of the board holds more than ${r.max} ${N(r.a)}.`;
    case "runCap":
      return `${N(r.a)} never runs more than ${r.max} in a row along a ${r.axis === "row" ? "row" : "column"}.`;
    case "runMod":
      return r.m === 2
        ? `Every unbroken ${r.axis === "row" ? "horizontal" : "vertical"} run of ${N(r.a)} has an even length.`
        : `Every unbroken ${r.axis === "row" ? "horizontal" : "vertical"} run of ${N(r.a)} has a length divisible by ${r.m}.`;
    case "reach":
      return `Every ${N(r.a)} can walk to the edge of the board through ${N(r.a)}, one orthogonal step at a time.`;
    case "regions":
      return `${N(r.a)} forms exactly ${r.k} separate orthogonally connected ${r.k === 1 ? "island" : "islands"}.`;
    case "mirror": {
      const how = {
        rot180: "a half turn about the centre",
        flipX: "a mirror down the vertical centre line",
        flipY: "a mirror across the horizontal centre line",
        transpose: "a flip about the main diagonal",
      }[r.op];
      return `The ${N(r.a)} cells look exactly the same after ${how}.`;
    }
    case "exclusive":
      return `No ${r.axis === "row" ? "row" : "column"} holds both ${N(r.a)} and ${N(r.b)} — a ${r.axis} that has one has none of the other.`;
    case "relCount": {
      const mul = (r.tenths / 10).toFixed(1);
      return r.cmp === "atLeast"
        ? `${N(r.a)} covers at least ${mul}× as many cells as ${N(r.b)}.`
        : `${N(r.a)} covers at most ${mul}× as many cells as ${N(r.b)}.`;
    }
    case "halfTilt": {
      const where = r.axis === "h" ? (r.heavy === 0 ? "top half" : "bottom half") : r.heavy === 0 ? "left half" : "right half";
      const rest = r.axis === "h" ? (r.heavy === 0 ? "bottom" : "top") : r.heavy === 0 ? "right" : "left";
      return `${N(r.a)} leans ${where}wards: at least ${r.margin} more of it there than in the ${rest} half.`;
    }
    case "zoneCount": {
      const where = zoneLabel(scheme, r.zone);
      return r.cmp === "atLeast"
        ? `${N(r.a)} covers at least ${r.n} cells of ${where}.`
        : `${N(r.a)} covers at most ${r.n} cells of ${where}.`;
    }
    case "countMod":
      return r.m === 2
        ? `The total number of ${N(r.a)} cells is ${r.r === 0 ? "even" : "odd"}.`
        : `The total number of ${N(r.a)} cells leaves remainder ${r.r} when divided by ${r.m}.`;
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "Tomato, Mint and Grape" — the reveal is prose, not a data dump. */
function list(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "nothing";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function bondText(b: Bond): string {
  return `${N(b.a)} + ${N(b.b)}`;
}
