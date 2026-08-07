import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  extent,
  fitAt,
  leastSquares,
  niceTicks,
  padExtent,
  type Fit,
  type XY,
} from "@/lib/bench";
import { seriesVar } from "./theme";

/**
 * One dot plot with a least-squares line per series.
 *
 * All three charts on the bench screen are the same picture with different
 * accessors, so they are the same component: a reader who has learned to read
 * the learning curve should not have to learn a second grammar for the cost
 * plot. Callers pre-flatten their data into `Mark`s, which keeps this file free
 * of generics and keeps tooltip content — the one thing that really does differ
 * per chart — with the caller who knows what the numbers mean.
 *
 * Two things changed in the redesign, both taken from how DeepSWE draws its
 * leaderboard chart:
 *
 * - **Series are direct-labelled at the end of their fit line.** A legend at
 *   the bottom makes the reader carry a colour across the page and back; a name
 *   sitting on the line does not. The legend stays as well, because it is where
 *   the slope and r² live and because identity must never be colour-alone.
 * - **The frame is recessive.** One hairline baseline, gridlines a step below
 *   that, and tick labels in mono at the muted colour. The data is the only
 *   thing on the plot with any contrast.
 */
export interface Mark {
  key: string;
  x: number;
  y: number;
  /** Tooltip heading. */
  title: string;
  /** Tooltip body, label/value pairs. */
  rows: [string, string][];
}

export interface ChartSeries {
  id: string;
  label: string;
  /** Palette slot, assigned by the caller and held for as long as the series is shown. */
  slot: number;
  marks: Mark[];
}

interface Props {
  series: ChartSeries[];
  /** Runs beyond the palette cap: drawn as context, never fitted. */
  other?: Mark[];
  otherLabel?: string;
  height?: number;
  xLabel: string;
  yLabel: string;
  formatX: (v: number) => string;
  formatY: (v: number) => string;
  /** Legend annotation for a fitted line, e.g. "−0.42 s per puzzle". */
  describeFit: (fit: Fit) => string;
  /** Shown when nothing has any data, which for the declared-value charts is common. */
  emptyMessage: string;
  /** Discrete x (difficulty bands) spreads overlapping dots instead of stacking them. */
  jitterX?: number;
  /** Override the x ticks where the axis is a small set of integers. */
  xTicks?: number[];
  /**
   * Solve times are heavy-tailed and multiplicative: a 4x speedup is the same
   * achievement at 400s->100s as at 40s->10s, and on a linear axis two slow
   * early boards own the whole vertical range. Log y fixes both, and makes an
   * exponential trend legible as a straight line without any fit at all.
   */
  yScale?: "linear" | "log";
  /**
   * `exp` fits least squares over (x, ln y) and draws it back through exp().
   * Exponential is the better-supported model for a *single* learner, which is
   * what one series is here; the classical power law is largely an artifact of
   * averaging across many learners, so it is not the right default for this
   * chart. Never a quadratic: it is non-monotone and will bend upward through
   * a sparse right-hand tail, inviting a reader to see a late-run slowdown
   * that is three noisy points.
   */
  fitModel?: "linear" | "exp";
  /**
   * Below this R2 the line is not drawn at all. A confident-looking trend
   * through noise is worse than no trend, and this page will be screenshotted.
   */
  minR2?: number;
}

/* Right margin leaves room for a direct label to sit outside the plot area. */
const M = { top: 14, right: 96, bottom: 38, left: 52 };
const HOVER_RADIUS = 30;
const MIN_FIT_POINTS = 5;
/** Minimum vertical gap between two direct labels before they get pushed apart. */
const LABEL_PITCH = 13;

interface Placed extends Mark {
  px: number;
  py: number;
  slot: number | null;
  seriesLabel: string;
}

export function ScatterFit({
  series,
  other = [],
  otherLabel = "other runs",
  height = 320,
  xLabel,
  yLabel,
  formatX,
  formatY,
  describeFit,
  emptyMessage,
  jitterX = 0,
  xTicks,
  yScale = "linear",
  fitModel = "linear",
  minR2 = 0,
}: Props) {
  const logY = yScale === "log";
  // Every y in this component travels in "view space": identity for a linear
  // axis, natural log for a log one. Scaling, padding and the fit all happen
  // there, and only the tick formatter and the tooltip see data space.
  const toView = useCallback((v: number) => (logY ? Math.log(v) : v), [logY]);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<Placed | null>(null);
  const [cursor, setCursor] = useState(-1);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  // A line through two or three points is arithmetic, not evidence — it will
  // report r² 1.00 and mean nothing. Below the floor the dots are still drawn
  // and the legend says why there is no line.
  const fits = useMemo(
    () =>
      series.map((s) => {
        const usable = logY ? s.marks.filter((m) => m.y > 0) : s.marks;
        if (usable.length < MIN_FIT_POINTS) return null;
        // An exponential fit is a straight line through (x, ln y); the same
        // one-pass least squares does both, which is why no new primitive was
        // needed in `lib/bench.ts` for this.
        const pts: XY[] =
          fitModel === "exp"
            ? usable.filter((m) => m.y > 0).map((m) => ({ x: m.x, y: Math.log(m.y) }))
            : (usable as XY[]);
        return leastSquares(pts);
      }),
    [series, fitModel, logY],
  );

  /** A fit exists but explains too little to draw. */
  const weak = (f: Fit | null | undefined) => f != null && f.r2 < minR2;
  const drawable = (f: Fit | null | undefined): f is Fit => f != null && f.r2 >= minR2;

  const model = useMemo(() => {
    // A non-positive y has no place on a log axis. Dropping it is the only
    // honest option — clamping it would invent a value.
    const all = [...series.flatMap((s) => s.marks), ...other].filter((m) => !logY || m.y > 0);
    const xs = extent(all.map((m) => m.x));
    const ys = extent(all.map((m) => toView(m.y)));
    if (!xs || !ys) return null;
    // `padExtent` floors at zero, which is right for a linear axis and wrong
    // in log space where view values are routinely negative.
    const pad = (e: { min: number; max: number }, f: number) => {
      const span = e.max - e.min || Math.abs(e.max) || 1;
      return { min: e.min - span * f, max: e.max + span * f };
    };
    return {
      xDomain: padExtent(xs, 0.04),
      yDomain: logY ? pad(ys, 0.09) : padExtent(ys, 0.09),
      count: all.length,
    };
  }, [series, other, logY, toView]);

  // On a narrow screen the direct-label gutter costs more than it buys: the
  // plot would be mostly margin. Below this width the labels are dropped and
  // the legend underneath carries identity on its own.
  const narrow = width > 0 && width < 420;
  const rightM = narrow ? 14 : M.right;

  const plotW = Math.max(0, width - M.left - rightM);
  const plotH = Math.max(0, height - M.top - M.bottom);

  const scaled = useMemo(() => {
    if (!model || plotW <= 0) return null;
    const { xDomain, yDomain } = model;
    const xSpan = xDomain.max - xDomain.min || 1;
    const ySpan = yDomain.max - yDomain.min || 1;
    const sx = (v: number) => M.left + ((v - xDomain.min) / xSpan) * plotW;
    /** Takes a data-space y and places it, applying the axis transform. */
    const sy = (v: number) => M.top + plotH - ((toView(v) - yDomain.min) / ySpan) * plotH;
    /** Places an already-transformed value, for the fit line. */
    const syView = (v: number) => M.top + plotH - ((v - yDomain.min) / ySpan) * plotH;

    // Deterministic offset from the mark key, so a dot does not jump between
    // renders — a wobbling point reads as new data.
    const jitter = (m: Mark) => {
      if (!jitterX) return 0;
      let h = 2166136261;
      for (let i = 0; i < m.key.length; i++) h = Math.imul(h ^ m.key.charCodeAt(i), 16777619);
      return (((h >>> 0) % 1000) / 1000 - 0.5) * jitterX;
    };

    const placed: Placed[] = [];
    const plottable = (m: Mark) => !logY || m.y > 0;
    for (const s of series) {
      for (const m of s.marks.filter(plottable)) {
        placed.push({ ...m, px: sx(m.x + jitter(m)), py: sy(m.y), slot: s.slot, seriesLabel: s.label });
      }
    }
    for (const m of other.filter(plottable)) {
      placed.push({ ...m, px: sx(m.x + jitter(m)), py: sy(m.y), slot: null, seriesLabel: otherLabel });
    }

    // Log ticks are the 1/2/5 decade steps that fall inside the domain, so the
    // labels stay numbers a reader can hold in their head.
    const logTicks = () => {
      const lo = Math.exp(yDomain.min);
      const hi = Math.exp(yDomain.max);
      const out: number[] = [];
      for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
        for (const m of [1, 2, 5]) {
          const v = m * 10 ** e;
          if (v >= lo && v <= hi) out.push(v);
        }
      }
      return out.length >= 2 ? out : [lo, hi];
    };

    return {
      sx,
      sy,
      syView,
      placed,
      xTicks:
        xTicks?.filter((t) => t >= xDomain.min && t <= xDomain.max) ??
        niceTicks(xDomain.min, xDomain.max, plotW > 460 ? 6 : 4),
      yTicks: logY ? logTicks() : niceTicks(yDomain.min, yDomain.max, plotH > 220 ? 5 : 3),
      xDomain,
      yDomain,
    };
  }, [model, plotW, plotH, series, other, otherLabel, jitterX, xTicks, logY, toView]);

  /**
   * Where each series' name goes: at the right-hand end of its fit line, or at
   * its rightmost dot when there was no fit. Anchors that would collide are
   * pushed apart in a single pass so two names never overprint — the reason
   * this is worth the code is that a colliding label is worse than no label.
   */
  const labels = useMemo(() => {
    if (!scaled || narrow) return [];
    const anchors = series
      .map((s, i) => {
        const fit = fits[i];
        let y: number;
        if (drawable(fit)) {
          const x1 = Math.min(fit.x1, scaled.xDomain.max);
          const yv = fitAt(fit, x1);
          y = fitModel === "exp" ? scaled.sy(Math.exp(yv)) : scaled.sy(yv);
        } else {
          const pool = logY ? s.marks.filter((m) => m.y > 0) : s.marks;
          const last = pool.reduce<Mark | null>((a, m) => (!a || m.x > a.x ? m : a), null);
          if (!last) return null;
          y = scaled.sy(last.y);
        }
        return { id: s.id, slot: s.slot, label: s.label, y: Math.min(Math.max(y, M.top + 4), M.top + plotH) };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null)
      .sort((a, b) => a.y - b.y);

    for (let i = 1; i < anchors.length; i++) {
      const prev = anchors[i - 1]!;
      const cur = anchors[i]!;
      if (cur.y - prev.y < LABEL_PITCH) cur.y = prev.y + LABEL_PITCH;
    }
    return anchors;
  }, [scaled, series, fits, plotH, narrow, fitModel, logY, minR2]);

  const onMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!scaled) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      let best: Placed | null = null;
      let bestD = HOVER_RADIUS * HOVER_RADIUS;
      for (const p of scaled.placed) {
        const d = (p.px - mx) ** 2 + (p.py - my) ** 2;
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      setHover(best);
    },
    [scaled],
  );

  // Keyboard parity: a hover-only value is a value some readers cannot reach.
  const onKey = useCallback(
    (e: React.KeyboardEvent<SVGSVGElement>) => {
      if (!scaled || scaled.placed.length === 0) return;
      const n = scaled.placed.length;
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const next = (cursor + (e.key === "ArrowRight" ? 1 : -1) + n) % n;
        setCursor(next);
        setHover(scaled.placed[next] ?? null);
      } else if (e.key === "Escape") {
        setCursor(-1);
        setHover(null);
      }
    },
    [scaled, cursor],
  );

  const hasData = (model?.count ?? 0) > 0;
  const clipId = `clip-${xLabel.replace(/\W+/g, "")}-${yLabel.replace(/\W+/g, "")}`;

  return (
    <div ref={wrap} className="relative w-full">
      {!hasData && (
        <div
          className="grid place-items-center rounded-[5px] rule-all px-6 text-center t-small"
          style={{ height, color: "var(--viz-muted)" }}
        >
          {emptyMessage}
        </div>
      )}

      {hasData && width > 0 && scaled && (
        <svg
          className="viz-plot viz-frame block w-full touch-pan-y"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          tabIndex={0}
          aria-label={`${yLabel} against ${xLabel}. ${model!.count} solves across ${series.length} runs. Use the table below the charts for the underlying values.`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKey}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={M.left} y={M.top} width={plotW} height={plotH} />
            </clipPath>
          </defs>

          {scaled.yTicks.map((t) => (
            <g key={`y${t}`}>
              <line
                x1={M.left}
                x2={M.left + plotW}
                y1={scaled.sy(t)}
                y2={scaled.sy(t)}
                style={{ stroke: "var(--viz-grid)" }}
                strokeWidth={1}
              />
              <text
                className="viz-tick"
                x={M.left - 8}
                y={scaled.sy(t)}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={10}
                fontFamily="var(--font-mono)"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {formatY(t)}
              </text>
            </g>
          ))}

          {scaled.xTicks.map((t) => (
            <text
              key={`x${t}`}
              className="viz-tick"
              x={scaled.sx(t)}
              y={M.top + plotH + 16}
              textAnchor="middle"
              fontSize={10}
              fontFamily="var(--font-mono)"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {formatX(t)}
            </text>
          ))}

          <line
            x1={M.left}
            x2={M.left + plotW}
            y1={M.top + plotH}
            y2={M.top + plotH}
            style={{ stroke: "var(--viz-axis)" }}
            strokeWidth={1}
          />

          {/* Axis names in the label register: 10px, uppercase, open tracking. */}
          <text
            x={M.left + plotW / 2}
            y={height - 4}
            textAnchor="middle"
            fontSize={10}
            letterSpacing="0.09em"
            style={{ textTransform: "uppercase" }}
          >
            {xLabel.toUpperCase()}
          </text>
          <text
            transform={`translate(11 ${M.top + plotH / 2}) rotate(-90)`}
            textAnchor="middle"
            fontSize={10}
            letterSpacing="0.09em"
          >
            {yLabel.toUpperCase()}
          </text>

          <g clipPath={`url(#${clipId})`}>
            {/* Context first, so a folded run never sits on top of a fitted one. */}
            {scaled.placed
              .filter((p) => p.slot === null)
              .map((p) => (
                <circle
                  key={p.key}
                  className="viz-dot"
                  cx={p.px}
                  cy={p.py}
                  r={2.2}
                  style={{ fill: "var(--viz-other)" }}
                  opacity={0.45}
                />
              ))}

            {scaled.placed
              .filter((p) => p.slot !== null)
              .map((p) => (
                <circle
                  key={p.key}
                  className="viz-dot"
                  cx={p.px}
                  cy={p.py}
                  r={hover?.key === p.key ? 5.5 : 3.6}
                  style={{ fill: seriesVar(p.slot!), stroke: "var(--viz-surface)" }}
                  /* The surface-coloured ring is what keeps two overlapping
                     dots legible as two dots. */
                  strokeWidth={1.5}
                  opacity={hover && hover.key !== p.key ? 0.5 : 0.95}
                />
              ))}

            {series.map((s, i) => {
              const fit = fits[i];
              if (!drawable(fit)) return null;
              const x0 = Math.max(fit.x0, scaled.xDomain.min);
              const x1 = Math.min(fit.x1, scaled.xDomain.max);
              // Sampled rather than a two-point line, because an exponential
              // fit drawn on a linear axis is a curve. On a log axis it comes
              // out straight, which is the whole point of pairing the two.
              const N = 32;
              const pts: string[] = [];
              for (let k = 0; k <= N; k++) {
                const x = x0 + ((x1 - x0) * k) / N;
                // `fitAt` answers in the space the fit was made in: raw y for a
                // linear model, ln(y) for an exponential one.
                const yv = fitAt(fit, x);
                const py = fitModel === "exp" ? scaled.sy(Math.exp(yv)) : scaled.sy(yv);
                if (Number.isFinite(py)) pts.push(`${scaled.sx(x).toFixed(1)},${py.toFixed(1)}`);
              }
              if (pts.length < 2) return null;
              return (
                <polyline
                  key={`fit-${s.id}`}
                  points={pts.join(" ")}
                  fill="none"
                  style={{ stroke: seriesVar(s.slot) }}
                  strokeWidth={1.75}
                  strokeLinecap="round"
                />
              );
            })}
          </g>

          {/* Direct labels, outside the clip so they can sit in the gutter. */}
          {labels.map((a) => (
            <text
              key={a.id}
              x={M.left + plotW + 8}
              y={a.y}
              dominantBaseline="middle"
              fontSize={11}
              style={{ fill: seriesVar(a.slot) }}
            >
              {a.label}
            </text>
          ))}

          {hover && (
            <circle
              cx={hover.px}
              cy={hover.py}
              r={8}
              fill="none"
              style={{ stroke: hover.slot === null ? "var(--viz-other)" : seriesVar(hover.slot) }}
              strokeWidth={1}
              opacity={0.8}
            />
          )}
        </svg>
      )}

      {hover && (
        <div
          className="pointer-events-none absolute z-10 max-w-56 rounded-[5px] rule-all px-2 py-1.5"
          style={{
            left: Math.min(Math.max(hover.px + 12, 4), Math.max(4, width - 180)),
            top: Math.max(hover.py - 10, 4),
            background: "var(--viz-surface)",
            color: "var(--viz-ink)",
          }}
        >
          <p className="mb-1 truncate text-[12px] leading-tight">{hover.title}</p>
          {hover.rows.map(([k, v]) => (
            <p key={k} className="flex justify-between gap-3 text-[11px] leading-[1.5]">
              <span style={{ color: "var(--viz-muted)" }}>{k}</span>
              <span className="t-num">{v}</span>
            </p>
          ))}
        </div>
      )}

      {hasData && (
        <ul className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
          {series.map((s, i) => {
            const fit = fits[i];
            return (
              <li key={s.id} className="flex items-center gap-1.5">
                <span
                  className="inline-block size-2 shrink-0 rounded-full"
                  style={{ background: seriesVar(s.slot) }}
                  aria-hidden
                />
                <span style={{ color: "var(--viz-ink)" }}>{s.label}</span>
                <span className="t-num" style={{ color: "var(--viz-muted)" }}>
                  {drawable(fit)
                    ? describeFit(fit)
                    : weak(fit)
                      ? `r² ${fit!.r2.toFixed(2)} — too noisy to fit a line`
                      : `${s.marks.length} point${s.marks.length === 1 ? "" : "s"} — too few to fit`}
                </span>
              </li>
            );
          })}
          {other.length > 0 && (
            <li className="flex items-center gap-1.5">
              <span
                className="inline-block size-2 shrink-0 rounded-full"
                style={{ background: "var(--viz-other)" }}
                aria-hidden
              />
              <span style={{ color: "var(--viz-muted)" }}>
                {otherLabel} ({other.length} solves, not fitted)
              </span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
