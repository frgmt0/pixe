/**
 * The chart-side maths: regression, axis scaling, and the formatters the
 * benchmark screen reads numbers out with.
 *
 * The summary statistics are deliberately *not* here. Median, p90 and the two
 * projections live in `shared/protocol.ts` and are computed once, server-side —
 * a second implementation on the client is how a table and its charts end up
 * quoting different numbers for the same run. What genuinely has to happen in
 * the browser is the least-squares fit, because the fit is over whichever runs
 * the reader has selected and asking the server for a slope per click would be
 * a round trip per click.
 */

// The point shape is the wire format; nothing about it is redeclared here.
export { PUZZLE_UNIVERSE } from "@shared/protocol";
import type { BenchRow as WireBenchRow, ChartPoint } from "@shared/protocol";

/**
 * The wire row, unchanged. This was briefly a local extension carrying
 * `effective_ms_per_solve`, `abandoned` and `abandon_rate` while those were
 * still being added server-side; they are declared in `shared/protocol.ts` now,
 * so the extension would only be a second place for the shape to drift.
 */
export type BenchRow = WireBenchRow;

/** Named for what it is on a chart rather than for the table it also feeds. */
export type BenchPoint = ChartPoint;

/**
 * What to call a run in a legend, a chip, or a tooltip.
 *
 * `harness` is null only for a run that never finished pairing, and such a run
 * cannot have been issued a board — so nothing that reaches a chart should hit
 * the fallback. It falls back to the run id rather than to an invented name
 * because a label is a place where a blank helps nobody, and the id is at least
 * true.
 */
export const runLabel = (r: { harness: string | null; run_id: string }): string =>
  r.harness ?? r.run_id;

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

export function fmtSeconds(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 600) return `${Math.round(s)}s`;
  return `${(s / 60).toFixed(1)}m`;
}

/** Compact hours: 1M puzzles at a leisurely pace runs to six figures. */
export function fmtHours(h: number): string {
  if (h < 10) return `${h.toFixed(1)} h`;
  if (h < 1000) return `${Math.round(h).toLocaleString()} h`;
  if (h < 100_000) return `${(h / 1000).toFixed(1)}k h`;
  return `${(h / 1000).toFixed(0)}k h`;
}

/** Hours restated as the unit a reader actually feels. */
export function fmtDurationLong(h: number): string {
  if (h < 48) return `${h.toFixed(0)} hours`;
  const d = h / 24;
  if (d < 365) return `${d.toFixed(0)} days`;
  return `${(d / 365).toFixed(1)} years`;
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

/* ------------------------------------------------------------------ */
/* Derived series                                                      */
/* ------------------------------------------------------------------ */

/** Total tokens for a solve, or null when the agent reported neither half. */
export function solveTokens(p: BenchPoint): number | null {
  if (p.tokens_in == null && p.tokens_out == null) return null;
  return (p.tokens_in ?? 0) + (p.tokens_out ?? 0);
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
