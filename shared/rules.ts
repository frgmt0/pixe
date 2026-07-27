import { CELLS, EMPTY, GRID, HUE_COUNT, hueName } from "./palette";
import type { ZoneScheme } from "./zones";
import { zoneLabel } from "./zones";

/**
 * Every rule primitive is statically checkable against a finished grid, which
 * is what lets the server re-validate a submission from the seed alone.
 *
 * Rules are keyed by hue and by zone. Per-cell variation comes from zone
 * membership — 4096 independent per-cell rules would be undeducible.
 */
export type Rule =
  /** Positional: this zone accepts only these hues. */
  | { t: "zone"; zone: number; hues: number[] }
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
  | { t: "farApart"; a: number; b: number };

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
  /** Drives the swatch's reaction intensity. Never rendered as a number. */
  progress: { have: number; need: number; dir: "atLeast" | "atMost" } | null;
}

const OK: RuleEval = { status: "ok", violations: [], touched: false, hue: null, progress: null };

function ok(touched: boolean, progress: RuleEval["progress"] = null, hue: number | null = null): RuleEval {
  return touched || progress ? { status: "ok", violations: [], touched, hue, progress } : OK;
}

export function evaluateRule(rule: Rule, grid: Grid, ctx: EvalCtx): RuleEval {
  switch (rule.t) {
    case "zone": {
      const allowed = new Uint8Array(HUE_COUNT);
      for (const h of rule.hues) allowed[h] = 1;
      const violations: number[] = [];
      let touched = false;
      for (let i = 0; i < CELLS; i++) {
        if (ctx.zmap[i] !== rule.zone) continue;
        const v = grid[i]!;
        if (v < 0) continue;
        touched = true;
        if (!allowed[v]) violations.push(i);
      }
      return violations.length
        ? { status: "broken", violations, touched: true, hue: null, progress: null }
        : ok(touched);
    }

    case "forbidAdj": {
      const { a, b } = rule;
      const violations: number[] = [];
      for (let i = 0; i < CELLS; i++) {
        const v = grid[i]!;
        if (v !== a && v !== b) continue;
        const other = v === a ? b : a;
        const x = i % GRID;
        if (x < GRID - 1 && grid[i + 1] === other) {
          violations.push(i, i + 1);
        }
        if (i + GRID < CELLS && grid[i + GRID] === other) {
          violations.push(i, i + GRID);
        }
      }
      const touched = ctx.counts[a]! > 0 || ctx.counts[b]! > 0;
      return violations.length
        ? { status: "broken", violations: dedupe(violations), touched: true, hue: null, progress: null }
        : ok(touched);
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
      return violations.length
        ? { status: "broken", violations: dedupe(violations), touched: true, hue: null, progress: null }
        : ok(touched);
    }

    case "requireAdj": {
      const { a, b } = rule;
      const violations: number[] = [];
      let pending = false;
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
        if (hasEmpty) pending = true;
        else violations.push(i);
      }
      const touched = ctx.counts[a]! > 0;
      if (violations.length) return { status: "broken", violations, touched: true, hue: null, progress: null };
      if (pending) return { status: "pending", violations: [], touched: true, hue: null, progress: null };
      return ok(touched);
    }

    case "buddy": {
      const { a } = rule;
      const violations: number[] = [];
      let pending = false;
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
        if (hasEmpty) pending = true;
        else violations.push(i);
      }
      const touched = ctx.counts[a]! > 0;
      if (violations.length) return { status: "broken", violations, touched: true, hue: null, progress: null };
      if (pending) return { status: "pending", violations: [], touched: true, hue: null, progress: null };
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
      return violations.length
        ? { status: "broken", violations: dedupe(violations), touched: true, hue: null, progress: null }
        : ok(touched);
    }

    case "parity": {
      const { a, p } = rule;
      const violations: number[] = [];
      for (let i = 0; i < CELLS; i++) {
        if (grid[i] !== a) continue;
        const x = i % GRID;
        const y = (i / GRID) | 0;
        if (((x + y) & 1) !== p) violations.push(i);
      }
      const touched = ctx.counts[a]! > 0;
      return violations.length
        ? { status: "broken", violations, touched: true, hue: null, progress: null }
        : ok(touched);
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
      return violations.length
        ? { status: "broken", violations: dedupe(violations), touched: true, hue: null, progress: null }
        : ok(touched);
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
      return violations.length
        ? { status: "broken", violations, touched: true, hue: null, progress: null }
        : ok(touched);
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
      return { status: "pending", violations: [], touched: have > 0, hue: a, progress };
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

/** How much a rule contributes to a puzzle's difficulty score. */
export function ruleWeight(r: Rule): number {
  switch (r.t) {
    case "zone":
      return 1 + Math.max(0, 4 - r.hues.length) * 0.4;
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
      const names = r.hues.map((h) => N(h)).join(", ");
      return `${cap(zoneLabel(scheme, r.zone))} only accepts ${names}.`;
    }
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
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function bondText(b: Bond): string {
  return `${N(b.a)} + ${N(b.b)}`;
}
