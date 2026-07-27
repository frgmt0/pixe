import { CELLS, EMPTY, GRID } from "@shared/palette";
import { emptyGrid, type Grid } from "@shared/rules";

export type Tool = "brush" | "bucket" | "rect" | "eraser" | "picker";
/** Paint the mirrored position(s) too — the cheapest route to art that looks composed. */
export type Mirror = "none" | "x" | "y" | "quad";

/**
 * The canvas model. Deliberately a plain mutable object rather than React
 * state: a drag can touch hundreds of cells per second and re-rendering a
 * 4096-entry structure on every pointer event would drop frames.
 *
 * Undo stores per-stroke diffs (cell -> previous value), so the stack can be
 * deep without holding hundreds of full grid copies. Depth matters here —
 * the game never states its rules, so probing and reverting IS the gameplay.
 */
const MAX_UNDO = 500;

export class Board {
  grid: Grid = emptyGrid();

  private undoStack: Map<number, number>[] = [];
  private redoStack: Map<number, number>[] = [];
  private pending: Map<number, number> | null = null;
  /** Bumped on every mutation so the renderer knows when to repaint. */
  version = 0;

  load(grid: Grid): void {
    this.grid = grid;
    this.undoStack = [];
    this.redoStack = [];
    this.pending = null;
    this.version++;
  }

  /* --- stroke bookkeeping ----------------------------------------- */

  begin(): void {
    this.pending = new Map();
  }

  /** Returns true if anything actually changed. */
  commit(): boolean {
    const diff = this.pending;
    this.pending = null;
    if (!diff || diff.size === 0) return false;
    this.undoStack.push(diff);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    return true;
  }

  private write(i: number, v: number): void {
    if (i < 0 || i >= CELLS) return;
    const prev = this.grid[i]!;
    if (prev === v) return;
    if (this.pending && !this.pending.has(i)) this.pending.set(i, prev);
    this.grid[i] = v;
    this.version++;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    const diff = this.undoStack.pop();
    if (!diff) return false;
    this.redoStack.push(this.invert(diff));
    this.version++;
    return true;
  }

  redo(): boolean {
    const diff = this.redoStack.pop();
    if (!diff) return false;
    this.undoStack.push(this.invert(diff));
    this.version++;
    return true;
  }

  /** Applies a diff and returns the diff that would undo it. */
  private invert(diff: Map<number, number>): Map<number, number> {
    const back = new Map<number, number>();
    for (const [i, prev] of diff) {
      back.set(i, this.grid[i]!);
      this.grid[i] = prev as -1 | number;
    }
    return back;
  }

  /* --- tools ------------------------------------------------------- */

  /** Square brush centred on (x, y), honouring the mirror mode. */
  paint(x: number, y: number, size: number, hue: number, mirror: Mirror): void {
    for (const [mx, my] of mirrorPoints(x, y, mirror)) this.stamp(mx, my, size, hue);
  }

  private stamp(cx: number, cy: number, size: number, hue: number): void {
    const half = (size - 1) / 2;
    const x0 = Math.max(0, Math.round(cx - half));
    const y0 = Math.max(0, Math.round(cy - half));
    const x1 = Math.min(GRID - 1, x0 + size - 1);
    const y1 = Math.min(GRID - 1, y0 + size - 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) this.write(y * GRID + x, hue);
    }
  }

  /**
   * Interpolates between two points so a fast drag paints a continuous line
   * instead of a dotted trail of sampled pointer positions.
   */
  stroke(x0: number, y0: number, x1: number, y1: number, size: number, hue: number, mirror: Mirror): void {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const steps = Math.max(dx, dy);
    if (steps === 0) {
      this.paint(x1, y1, size, hue, mirror);
      return;
    }
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      this.paint(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), size, hue, mirror);
    }
  }

  /** 4-connected flood fill over the contiguous run of whatever is under (x, y). */
  bucket(x: number, y: number, hue: number, mirror: Mirror): void {
    for (const [mx, my] of mirrorPoints(x, y, mirror)) this.flood(mx, my, hue);
  }

  private flood(x: number, y: number, hue: number): void {
    const start = y * GRID + x;
    const from = this.grid[start];
    if (from === undefined || from === hue) return;

    // Explicit stack rather than recursion: a fill can span all 4096 cells.
    const stack: number[] = [start];
    const seen = new Uint8Array(CELLS);
    seen[start] = 1;

    const push = (j: number) => {
      if (seen[j] || this.grid[j] !== from) return;
      seen[j] = 1;
      stack.push(j);
    };

    while (stack.length) {
      const i = stack.pop()!;
      this.write(i, hue);
      const cx = i % GRID;
      if (cx > 0) push(i - 1);
      if (cx < GRID - 1) push(i + 1);
      if (i >= GRID) push(i - GRID);
      if (i + GRID < CELLS) push(i + GRID);
    }
  }

  rect(x0: number, y0: number, x1: number, y1: number, hue: number, mirror: Mirror): void {
    const ax = Math.min(x0, x1);
    const bx = Math.max(x0, x1);
    const ay = Math.min(y0, y1);
    const by = Math.max(y0, y1);
    for (let y = ay; y <= by; y++) {
      for (let x = ax; x <= bx; x++) {
        for (const [mx, my] of mirrorPoints(x, y, mirror)) {
          this.write(my * GRID + mx, hue);
        }
      }
    }
  }

  fillAll(hue: number): void {
    for (let i = 0; i < CELLS; i++) this.write(i, hue);
  }

  clear(): void {
    this.fillAll(EMPTY);
  }

  /** Replaces every cell currently holding `from` with `to`, grid-wide. */
  swapHue(from: number, to: number): void {
    for (let i = 0; i < CELLS; i++) if (this.grid[i] === from) this.write(i, to);
  }

  countFilled(): number {
    let n = 0;
    for (let i = 0; i < CELLS; i++) if (this.grid[i]! >= 0) n++;
    return n;
  }
}

export function mirrorPoints(x: number, y: number, mode: Mirror): [number, number][] {
  const mx = GRID - 1 - x;
  const my = GRID - 1 - y;
  switch (mode) {
    case "none":
      return [[x, y]];
    case "x":
      return dedupePoints([
        [x, y],
        [mx, y],
      ]);
    case "y":
      return dedupePoints([
        [x, y],
        [x, my],
      ]);
    case "quad":
      return dedupePoints([
        [x, y],
        [mx, y],
        [x, my],
        [mx, my],
      ]);
  }
}

function dedupePoints(pts: [number, number][]): [number, number][] {
  const seen = new Set<number>();
  const out: [number, number][] = [];
  for (const p of pts) {
    const k = p[1] * GRID + p[0];
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}
