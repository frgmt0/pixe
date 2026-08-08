/**
 * The chart-side maths and the shared formatters the benchmark screen reads
 * numbers out with.
 *
 * The summary statistics are deliberately *not* here. Progress, pace, the two
 * meter sums and the projection all live in `shared/protocol.ts` and are
 * computed once, server-side — a second implementation on the client is how a
 * table and its charts end up quoting different numbers for the same row.
 * What genuinely has to happen in the browser is the least-squares fit for the
 * learning curve, because the fit is over whichever row's chain the reader has
 * expanded and asking the server for a slope per click would be a round trip
 * per click.
 *
 * `/api/bench` now returns one row per `(model, provider)` — `BenchGroupRow`
 * in `shared/protocol.ts` — not one row per run. `BenchRow` below is that
 * grouped shape, not the per-run row it used to re-export; the per-run shape
 * survives as `BenchMember`, which is what a group's `members` array (fetched
 * with `?members=1`) and `/api/bench/points` still carry.
 */

// The point shape is the wire format; nothing about it is redeclared here.
import type {
  BenchGroupRow as WireBenchGroupRow,
  BenchRow as WireBenchRow,
  ChartPoint,
} from "@shared/protocol";

/** One run inside a model's group — the shape `?members=1` unfolds and the
 *  shape `/api/bench` served before the table was model-grouped. */
export type BenchMember = WireBenchRow;

/** Named for what it is on a chart rather than for the table it also feeds. */
export type BenchPoint = ChartPoint;

const MS_PER_HOUR = 3_600_000;
/** The ladder is a fixed, brutally hard 500 boards. Used only as a fallback
 *  when the server response has not yet said so via `universe`. */
export const LADDER_SIZE = 500;

/**
 * The model-grouped row the table renders.
 *
 * Extends the wire `BenchGroupRow` with two fields the server may not have
 * shipped yet during rollout: `projected_500_hours` and `complete`. See
 * `toBenchRow` below, which is the one place either is filled in when the
 * wire row does not already carry them.
 */
export interface BenchRow extends WireBenchGroupRow {
  /** Serial wall-clock hours to clear the whole 500-board ladder at this
   *  row's effective pace — `effective_ms_per_solve × universe / 3.6e6`.
   *  Read straight off the wire once the server sends it; computed here as a
   *  fallback so the page still renders correctly against an older response. */
  projected_500_hours: number;
  /** Every rung on the ladder banked. Read off the wire when present,
   *  otherwise inferred from `solves` reaching the ladder size. */
  complete: boolean;
  members?: BenchMember[];
}

/**
 * Fills in `projected_500_hours` and `complete` when the wire row does not
 * already carry them. `universe` should be the payload's own `universe`
 * field — 500, the fixed ladder size — never hardcoded twice.
 */
export function toBenchRow(w: WireBenchGroupRow, universe: number): BenchRow {
  const extra = w as unknown as { projected_500_hours?: number; complete?: boolean };
  return {
    ...w,
    projected_500_hours:
      typeof extra.projected_500_hours === "number"
        ? extra.projected_500_hours
        : (w.effective_ms_per_solve * universe) / MS_PER_HOUR,
    complete: typeof extra.complete === "boolean" ? extra.complete : universe > 0 && w.solves >= universe,
  };
}

/**
 * What to call a row in a chart legend or tooltip.
 *
 * The model, which the run declared about itself and nothing verified. It
 * falls back to the run id rather than to an invented name because a label is
 * a place where a blank helps nobody, and the id is at least true.
 */
export const runLabel = (r: { model: string; run_id: string }): string => r.model || r.run_id;

/* ------------------------------------------------------------------ */
/* Least squares                                                       */
/* ------------------------------------------------------------------ */

export interface Fit {
  slope: number;
  intercept: number;
  /** Coefficient of determination. 0 when y is constant — see below. */
  r2: number;
  n: number;
  x0: number;
  x1: number;
}

export interface XY {
  x: number;
  y: number;
}

/**
 * Ordinary least squares, one pass.
 *
 * Returns null rather than a degenerate line for the two cases where a slope
 * is meaningless: fewer than two points, and every x identical (a vertical
 * line, whose slope is infinite). Callers draw nothing in that case, which is
 * the honest rendering — a flat line through a single point would read as a
 * trend that was never measured.
 *
 * Computed from centred sums rather than the textbook `Σxy − nx̄ȳ` form: with
 * wall-clock milliseconds and six-figure token counts the raw sums are large
 * enough that the difference of two big numbers loses most of its significant
 * digits.
 */
export function leastSquares(points: readonly XY[]): Fit | null {
  const usable = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (usable.length < 2) return null;

  let sx = 0;
  let sy = 0;
  for (const p of usable) {
    sx += p.x;
    sy += p.y;
  }
  const mx = sx / usable.length;
  const my = sy / usable.length;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const p of usable) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
  }
  if (sxx === 0) return null;

  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  // A constant y has no variance to explain, so no fraction of it can be
  // explained. Reporting 1 there would flatter a line that predicts nothing.
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2, n: usable.length, x0, x1 };
}

export const fitAt = (fit: Fit, x: number): number => fit.intercept + fit.slope * x;

/* ------------------------------------------------------------------ */
/* Scales and ticks                                                    */
/* ------------------------------------------------------------------ */

export interface Extent {
  min: number;
  max: number;
}

export function extent(xs: readonly number[]): Extent | null {
  if (xs.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const x of xs) {
    if (!Number.isFinite(x)) continue;
    if (x < min) min = x;
    if (x > max) max = x;
  }
  return Number.isFinite(min) ? { min, max } : null;
}

/**
 * Round tick values (1 / 2 / 5 × 10ⁿ) covering `min..max`.
 *
 * Axis labels are the values the chart did not direct-label, so they have to be
 * numbers a reader can hold in their head — 0, 20, 40, not 0, 17.3, 34.6.
 */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const raw = (max - min) / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 1e-9; v += step) {
    // Re-round each tick: repeated addition of 0.1 drifts into 0.30000000000000004.
    out.push(Math.round(v / step) * step);
  }
  return out;
}

/** Pad an extent outward so marks never sit on the frame. Never below zero. */
export function padExtent(e: Extent, frac = 0.06): Extent {
  const span = e.max - e.min || Math.abs(e.max) || 1;
  return { min: Math.max(0, e.min - span * frac), max: e.max + span * frac };
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/**
 * Solve-scale durations — "effective / solve", "median solve" — humanized the
 * way a reader actually says them: `4.2s`, `45s`, `1m 05s`, `2h 03m`.
 */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSec = ms / 1000;
  if (totalSec < 10) return `${totalSec.toFixed(1)}s`;
  if (totalSec < 60) return `${Math.round(totalSec)}s`;
  const whole = Math.round(totalSec);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/**
 * Ladder-scale durations — the projected full-ladder time — in the unit a
 * reader actually feels: `34h`, `3d 2h`, `1.2y`.
 */
export function fmtDurationLong(hours: number): string {
  if (!Number.isFinite(hours)) return "—";
  if (hours < 48) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 365) {
    const d = Math.floor(days);
    const remH = Math.round((days - d) * 24);
    return remH > 0 ? `${d}d ${remH}h` : `${d}d`;
  }
  return `${(days / 365).toFixed(1)}y`;
}

/** Sign outside the symbol: `−$0.27`, never `$−0.27`. Regression slopes go negative. */
export function fmtUsd(usd: number): string {
  if (usd === 0) return "$0";
  const sign = usd < 0 ? "−" : "";
  const v = Math.abs(usd);
  if (v < 0.01) return `${sign}$${v.toFixed(4)}`;
  if (v < 10) return `${sign}$${v.toFixed(3)}`;
  if (v < 1000) return `${sign}$${v.toFixed(2)}`;
  if (v < 1_000_000) return `${sign}$${(v / 1000).toFixed(1)}k`;
  return `${sign}$${(v / 1_000_000).toFixed(2)}M`;
}

export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return `${Math.round(n)}`;
  if (abs < 1_000_000) return `${(n / 1000).toFixed(abs < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export const microToUsd = (micro: number): number => micro / 1_000_000;

/** Percentages under 1% still need to read as "some", not as "none". */
export function fmtRate(r: number): string {
  if (r === 0) return "0%";
  if (r < 0.01) return "<1%";
  return `${Math.round(r * 100)}%`;
}

/** Tokens per second: one decimal below 10, whole above — a TPS of "6.4" and
 *  one of "640" both read at a glance. */
export function fmtTps(v: number): string {
  if (v < 10) return v.toFixed(1);
  return `${Math.round(v)}`;
}

/* ------------------------------------------------------------------ */
/* Derived figures                                                     */
/* ------------------------------------------------------------------ */

/** Total tokens for one solve, or null when the agent reported neither half. */
export function solveTokens(p: BenchPoint): number | null {
  if (p.tokens_in == null && p.tokens_out == null) return null;
  return (p.tokens_in ?? 0) + (p.tokens_out ?? 0);
}

/**
 * Declared tokens out ÷ measured solve time, over the whole group of solves a
 * row's `solves`/`effective_ms_per_solve` describe. Approximate — the meter is
 * cumulative-and-resent per rung, not per output token — and blank whenever
 * either half is unmeasurable, never zero.
 */
export function tpsOf(r: Pick<BenchRow, "tokensOut" | "solves" | "effective_ms_per_solve">): number | null {
  if (r.tokensOut == null || r.solves <= 0 || r.effective_ms_per_solve <= 0) return null;
  const totalSeconds = (r.solves * r.effective_ms_per_solve) / 1000;
  return totalSeconds > 0 ? r.tokensOut / totalSeconds : null;
}

export function groupByRun(points: readonly BenchPoint[]): Map<string, BenchPoint[]> {
  const out = new Map<string, BenchPoint[]>();
  for (const p of points) {
    const bucket = out.get(p.run_id);
    if (bucket) bucket.push(p);
    else out.set(p.run_id, [p]);
  }
  for (const bucket of out.values()) bucket.sort((a, b) => a.idx - b.idx);
  return out;
}
