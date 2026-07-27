import { generate, countBonds, type Puzzle } from "./generate";
import { CELLS } from "./palette";
import { evaluateRule, makeCtx, type Grid, type RuleEval } from "./rules";
import { zoneMap } from "./zones";

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

const zmapCache = new Map<string, Uint8Array>();

function zmapFor(p: Puzzle): Uint8Array {
  let m = zmapCache.get(p.key);
  if (!m) {
    m = zoneMap(p.scheme);
    if (zmapCache.size > 256) zmapCache.clear();
    zmapCache.set(p.key, m);
  }
  return m;
}

/**
 * The one evaluation path. The client runs it on every stroke to drive the
 * glow, and the server runs it on submit. Identical code, so a submission can
 * never be accepted under different rules than the ones the player fought.
 */
export function assess(key: string, grid: Grid): Assessment {
  const { puzzle } = generate(key);
  const zmap = zmapFor(puzzle);
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
    if (ev.hue !== null) hotHues.add(ev.hue);
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
