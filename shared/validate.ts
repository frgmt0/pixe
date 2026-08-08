import { countBonds, generate, zmapForScheme, type Puzzle } from "./generate";
import { CELLS } from "./palette";
import { buzzedHues, evaluateRule, makeCtx, type Grid, type RuleEval } from "./rules";

export interface Assessment {
  puzzle: Puzzle;
  /** Per-rule verdict, index-aligned with `puzzle.rules`. */
  evals: RuleEval[];
  /** Union of every rule's violating cells. */
  badCells: Set<number>;
  /**
   * Hues whose palette swatch should react. This is the only feedback channel
   * counting rules have, so without it a full grid failing only a quota would
   * show the player nothing at all.
   */
  hotHues: Set<number>;
  filled: number;
  empty: number;
  bonds: number;
  /** Every cell painted AND every rule satisfied. */
  solved: boolean;
}

/**
 * The one evaluation path. The client runs it on every stroke to drive the
 * glow, and the server runs it on submit. Identical code, so a submission can
 * never be accepted under different rules than the ones the player fought.
 */
export function assess(key: string, grid: Grid): Assessment {
  const { puzzle } = generate(key);
  return assessAgainst(puzzle, grid);
}

/** The same verdict, for a puzzle already in hand — every phase past the first. */
export function assessAgainst(puzzle: Puzzle, grid: Grid): Assessment {
  const zmap = zmapForScheme(`${puzzle.key}:${puzzle.phase}:${JSON.stringify(puzzle.scheme)}`, puzzle.scheme);
  const ctx = makeCtx(grid, zmap);

  const evals: RuleEval[] = [];
  const badCells = new Set<number>();
  const hotHues = new Set<number>();
  let allOk = true;

  for (const rule of puzzle.rules) {
    const ev = evaluateRule(rule, grid, ctx);
    evals.push(ev);
    if (ev.status === "ok") continue;
    allOk = false;
    for (const c of ev.violations) badCells.add(c);
    for (const h of buzzedHues(ev)) hotHues.add(h);
  }

  const filled = CELLS - ctx.empties;
  return {
    puzzle,
    evals,
    badCells,
    hotHues,
    filled,
    empty: ctx.empties,
    bonds: countBonds(grid, puzzle.bonds),
    solved: ctx.empties === 0 && allOk,
  };
}
