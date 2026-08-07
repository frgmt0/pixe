import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  fmtCompact,
  fmtDurationLong,
  fmtSeconds,
  fmtUsd,
  groupByRun,
  microToUsd,
  runLabel,
  solveTokens,
  type BenchPoint,
  type BenchRow,
} from "@/lib/bench";
import { BenchTable } from "@/components/charts/BenchTable";
import { ScatterFit, type ChartSeries, type Mark } from "@/components/charts/ScatterFit";
import { ChartTokens, SERIES_CAP, seriesVar } from "@/components/charts/theme";

/**
 * The benchmark screen.
 *
 * It is a measurement page, not a scoreboard: the thing a reader should take
 * away is how long an agent takes per puzzle and what that costs in wall clock
 * across the whole puzzle space. So wall time gets the hero figure, the largest
 * chart and the default sort, and the declared numbers — tokens, dollars, and
 * the agent's own name for itself — sit in a quieter register with one plain
 * statement about where they come from.
 *
 * The layout follows DeepSWE's: a title with the run of the benchmark stated as
 * a small right-aligned mono key/value block beside it, a hairline, then the
 * one number the page exists to report, then the charts, then the table. There
 * are no cards. Grouping is space and a 0.8px rule, which is how both
 * references do it.
 */

interface BenchPayload {
  rows: BenchRow[];
  universe: number;
  pointsConsidered: number;
  truncated: boolean;
}

interface PointsPayload {
  points: BenchPoint[];
  truncated: boolean;
}

export function Bench() {
  const [bench, setBench] = useState<BenchPayload | null>(null);
  const [points, setPoints] = useState<BenchPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Slot per run id. A run holds its colour for as long as it is plotted, so
  // removing one series never repaints the others.
  const [slots, setSlots] = useState<Map<string, number>>(new Map());
  const [touched, setTouched] = useState(false);
  /**
   * Puzzle index is not a neutral x-axis: `bandFor` in `server/runs.ts` widens
   * the difficulty band geometrically with chain position, so the boards get
   * harder as the run climbs. Plotting raw seconds against index therefore
   * mixes two opposing forces — the agent getting faster, the boards getting
   * harder — and a trend through that mixture can come out flat while the agent
   * improved a great deal underneath it. Dividing by the solve's own difficulty
   * separates the two, so it is the default view; raw seconds stays available
   * because it is the number people actually recognise.
   */
  const [perDifficulty, setPerDifficulty] = useState(true);

  useEffect(() => {
    let live = true;
    Promise.all([
      fetch("/api/bench").then((r) => r.json() as Promise<BenchPayload>),
      fetch("/api/bench/points").then((r) => r.json() as Promise<PointsPayload>),
    ])
      .then(([b, p]) => {
        if (!live) return;
        setBench(b);
        setPoints(p.points);
      })
      .catch(() => live && setError("Couldn't load the benchmark."));
    return () => {
      live = false;
    };
  }, []);

  const rows = bench?.rows ?? [];

  // Default to the three fastest runs. Deferred until the user touches the
  // selection, after which it is theirs.
  useEffect(() => {
    if (touched || rows.length === 0) return;
    setSlots(new Map(rows.slice(0, SERIES_CAP).map((r, i) => [r.run_id, i])));
  }, [rows, touched]);

  const toggle = useCallback((runId: string) => {
    setTouched(true);
    setSlots((prev) => {
      const next = new Map(prev);
      if (next.delete(runId)) return next;
      const used = new Set(next.values());
      for (let s = 0; s < SERIES_CAP; s++) {
        if (!used.has(s)) {
          next.set(runId, s);
          return next;
        }
      }
      return next; // Full: the palette caps at three distinguishable hues.
    });
  }, []);

  const byRun = useMemo(() => groupByRun(points ?? []), [points]);
  const nameOf = useMemo(() => new Map(rows.map((r) => [r.run_id, runLabel(r)])), [rows]);

  const selected = useMemo(
    () =>
      [...slots.entries()]
        .map(([runId, slot]) => ({ runId, slot, row: rows.find((r) => r.run_id === runId) }))
        .filter((s) => s.row)
        .sort((a, b) => a.slot - b.slot),
    [slots, rows],
  );

  const build = useCallback(
    (
      accessor: (p: BenchPoint) => { x: number; y: number } | null,
      detail: (p: BenchPoint) => [string, string][],
    ) => {
      const series: ChartSeries[] = [];
      for (const { runId, slot, row } of selected) {
        const marks: Mark[] = [];
        for (const p of byRun.get(runId) ?? []) {
          const xy = accessor(p);
          if (!xy) continue;
          marks.push({
            key: `${p.run_id}:${p.idx}`,
            ...xy,
            title: `${runLabel(row!)} · puzzle #${p.idx + 1}`,
            rows: detail(p),
          });
        }
        if (marks.length) series.push({ id: runId, label: runLabel(row!), slot, marks });
      }

      const other: Mark[] = [];
      for (const [runId, pts] of byRun) {
        if (slots.has(runId)) continue;
        for (const p of pts) {
          const xy = accessor(p);
          if (!xy) continue;
          other.push({
            key: `${p.run_id}:${p.idx}`,
            ...xy,
            title: `${nameOf.get(runId) ?? "run"} · puzzle #${p.idx + 1}`,
            rows: detail(p),
          });
        }
      }
      return { series, other };
    },
    [selected, byRun, slots, nameOf],
  );

  const curve = useMemo(
    () =>
      build(
        (p) => {
          const secs = p.wall_ms / 1000;
          // Difficulty is a 3-7 integer and never zero, but a bad row must not
          // become an Infinity that swallows the axis.
          if (perDifficulty && !(p.difficulty > 0)) return null;
          return { x: p.idx + 1, y: perDifficulty ? secs / p.difficulty : secs };
        },
        (p) => [
          ["wall clock", fmtSeconds(p.wall_ms)],
          ["difficulty", `${p.difficulty}`],
          ["per difficulty", `${(p.wall_ms / 1000 / (p.difficulty || 1)).toFixed(1)}s`],
          ["points", `${p.points}`],
        ],
      ),
    [build, perDifficulty],
  );

  const cost = useMemo(
    () =>
      build(
        // Only solves that carried a cost. An unreported cost is not a zero and
        // must never be interpolated into the regression.
        (p) => (p.cost_micro == null ? null : { x: p.difficulty, y: microToUsd(p.cost_micro) }),
        (p) => [
          ["cost", fmtUsd(microToUsd(p.cost_micro ?? 0))],
          ["difficulty", `${p.difficulty}`],
          ["wall clock", fmtSeconds(p.wall_ms)],
        ],
      ),
    [build],
  );

  const tokens = useMemo(
    () =>
      build(
        (p) => {
          const t = solveTokens(p);
          return t == null ? null : { x: p.wall_ms / 1000, y: t };
        },
        (p) => [
          ["tokens", fmtCompact(solveTokens(p) ?? 0)],
          ["wall clock", fmtSeconds(p.wall_ms)],
          ["difficulty", `${p.difficulty}`],
        ],
      ),
    [build],
  );

  const leader = rows[0];
  const totalSolves = rows.reduce((a, r) => a + r.solved, 0);

  if (error) {
    return (
      <div className="viz-root mx-auto w-full max-w-6xl px-5 py-16">
        <ChartTokens />
        <p className="text-center text-bad">{error}</p>
      </div>
    );
  }

  if (!bench || !points) {
    return (
      <div className="viz-root grid min-h-[60vh] place-items-center">
        <ChartTokens />
        <Loader2 className="size-4 animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="viz-root mx-auto w-full max-w-6xl px-5 pb-24">
      <ChartTokens />

      {/* Title, with the shape of the benchmark stated beside it as data. This
          is DeepSWE's hero exactly: labels left in muted mono, values right in
          ink mono, and a hairline underneath. */}
      <header className="flex flex-col gap-6 pt-2 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-xl">
          <h1 className="t-display">The pixe benchmark</h1>
          <p className="mt-3 text-muted">
            Every run is issued one puzzle at a time; the next key is derived from the verified
            solution to the last. So this measures how fast an agent actually deduces a board's laws
            — not how many requests it can hold open at once.
          </p>
        </div>
        <dl className="shrink-0 t-num text-[11px] sm:min-w-44">
          <Fact label="runs" value={rows.length.toLocaleString()} />
          <Fact
            label="solves"
            value={totalSolves.toLocaleString()}
            note={bench.truncated ? "recent window" : undefined}
          />
          <Fact label="puzzles" value={bench.universe.toLocaleString()} />
        </dl>
      </header>

      {rows.length === 0 ? (
        <p className="rule-t py-20 text-center text-muted">No run has banked a solve yet.</p>
      ) : (
        <>
          {/* The number the page exists to report. Nothing else gets this size. */}
          <section className="rule-t rule-b py-7">
            <p className="t-micro text-muted">
              Fastest run, projected to all {bench.universe.toLocaleString()} puzzles
            </p>
            {/* Sans, not mono. Mono is for figures sitting in a column where
                alignment is the point; this is a headline and both references
                set display type in the text face. Tabular so the digits still
                have even colour. */}
            <p className="mt-2 text-[44px] leading-none tracking-[-0.03em] tabular-nums">
              {fmtDurationLong(leader!.projected_1m_hours)}
            </p>
            <p className="mt-2.5 max-w-xl text-muted">
              <span className="text-ink">{runLabel(leader!)}</span> at{" "}
              <span className="t-num text-ink">{fmtSeconds(leader!.effective_ms_per_solve)}</span>{" "}
              per solve including abandoned boards, held serially.
            </p>
          </section>

          {/* The picker sits above the charts because it drives all three. */}
          <section className="pt-7 pb-3">
            <p className="t-micro mb-2 text-muted">Plotted runs — pick up to {SERIES_CAP}</p>
            <div className="flex flex-wrap gap-1.5">
              {rows.map((r) => {
                const slot = slots.get(r.run_id);
                const on = slot !== undefined;
                return (
                  <button
                    key={r.run_id}
                    type="button"
                    onClick={() => toggle(r.run_id)}
                    aria-pressed={on}
                    className={`flex items-center gap-1.5 rounded-[4px] rule-all px-2 py-0.5 text-[12px] transition-colors ${
                      on ? "text-ink" : "text-muted hover:bg-sunk"
                    }`}
                  >
                    <span
                      className="inline-block size-2 rounded-full"
                      style={{ background: on ? seriesVar(slot) : "var(--viz-other)" }}
                      aria-hidden
                    />
                    {runLabel(r)}
                  </button>
                );
              })}
            </div>
          </section>

          {/* The learning curve is the only object on the site drawn entirely
              from measured data, so it gets the full column and the height. */}
          <Panel
            title="Learning curve"
            subtitle={
              <>
                Wall clock per puzzle across a run's chain, measured server-side from issue to
                accepted. <span className="text-ink">Puzzle difficulty rises with index by design</span>{" "}
                — the band a board is drawn from widens as the run climbs — so raw seconds mixes the
                agent getting faster with the boards getting harder, and the two can cancel into a
                flat line. Dividing by each board's own difficulty separates them. The y-axis is
                logarithmic and the fit is exponential, so a straight downward line is a constant
                percentage gain per puzzle.
              </>
            }
            control={
              <Segmented
                value={perDifficulty ? "norm" : "raw"}
                onChange={(v) => setPerDifficulty(v === "norm")}
                options={[
                  { id: "norm", label: "per difficulty" },
                  { id: "raw", label: "raw seconds" },
                ]}
              />
            }
            lead
          >
            <ScatterFit
              series={curve.series}
              other={curve.other}
              height={430}
              xLabel="puzzle number in the run's chain"
              yLabel={perDifficulty ? "seconds per difficulty point" : "seconds to solve"}
              yScale="log"
              fitModel="exp"
              /* Below this the line is not drawn at all. A confident-looking
                 trend through noise is worse than none on a page that gets
                 screenshotted. */
              minR2={0.15}
              formatX={(v) => `${Math.round(v)}`}
              formatY={fmtLogSeconds}
              describeFit={(f) => {
                // The fit is over ln(y), so the slope is a growth rate per
                // puzzle. A percentage is the only reading of it anyone wants.
                const pct = (Math.exp(f.slope) - 1) * 100;
                return `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}% per puzzle · r² ${f.r2.toFixed(2)}`;
              }}
              emptyMessage="Nothing plotted. Pick a run above."
            />
          </Panel>

          <div className="grid gap-10 lg:grid-cols-2">
            <Panel
              title="Cost per solve against difficulty"
              subtitle="Declared by the run. Runs that report no cost are absent here and lose nothing for it."
            >
              <ScatterFit
                series={cost.series}
                other={cost.other}
                height={260}
                xLabel="puzzle difficulty"
                yLabel="USD per solve"
                xTicks={[3, 4, 5, 6, 7]}
                formatX={(v) => v.toFixed(0)}
                formatY={(v) => `$${v.toFixed(2)}`}
                describeFit={(f) => `${fmtUsd(f.slope)} per difficulty step · r² ${f.r2.toFixed(2)}`}
                emptyMessage="None of the plotted runs declared a cost."
                jitterX={0.5}
              />
            </Panel>

            <Panel
              title="Tokens against wall clock"
              subtitle="Declared by the run. Thinking longer and spending more usually travel together — where they don't is the interesting part."
            >
              <ScatterFit
                series={tokens.series}
                other={tokens.other}
                height={260}
                xLabel="seconds to solve"
                yLabel="tokens per solve"
                formatX={(v) => `${Math.round(v)}s`}
                formatY={(v) => fmtCompact(v)}
                describeFit={(f) => `${fmtCompact(f.slope)} tokens per second · r² ${f.r2.toFixed(2)}`}
                emptyMessage="None of the plotted runs declared token counts."
              />
            </Panel>
          </div>

          <section className="mt-12">
            <h2 className="t-title mb-3">Every run</h2>
            <BenchTable rows={rows} plotted={slots} onToggle={toggle} />
          </section>

          <SolveTable points={points} nameOf={nameOf} />
        </>
      )}
    </div>
  );
}

/** One row of the hero key/value block. */
function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-0.5">
      <dt className="text-muted">{label}</dt>
      <dd className="text-ink">
        {note && <span className="mr-1.5 text-muted">{note}</span>}
        {value}
      </dd>
    </div>
  );
}

function Panel({
  title,
  subtitle,
  control,
  lead,
  children,
}: {
  title: string;
  subtitle: React.ReactNode;
  /** A view switch, set on the heading line where it cannot be mistaken for data. */
  control?: React.ReactNode;
  /** The learning curve: bigger heading, more room around it. */
  lead?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={lead ? "mt-2 mb-12" : ""}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className={lead ? "t-title" : "t-lead"}>{title}</h2>
        {control}
      </div>
      <p className="mt-1 mb-4 max-w-2xl t-small text-muted">{subtitle}</p>
      {children}
    </section>
  );
}

/**
 * On a log axis the ticks are 1/2/5 decade steps, so they land on fractions as
 * readily as on round hundreds and a single formatter has to cope with both.
 */
function fmtLogSeconds(v: number): string {
  if (v >= 10) return `${Math.round(v)}s`;
  if (v >= 1) return `${v.toFixed(1)}s`;
  return `${v.toFixed(2)}s`;
}

/** The segmented switch, same object as the one in the painting toolbar. */
function Segmented({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange(id: string): void;
  options: { id: string; label: string }[];
}) {
  return (
    <div className="flex overflow-hidden rounded-[4px] rule-all [&>button:not(:first-child)]:rule-l">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          aria-pressed={value === o.id}
          className={`px-2 py-0.5 text-[11px] transition-colors ${
            value === o.id ? "bg-solid text-on-solid" : "text-muted hover:bg-sunk hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The charts' table twin. Every value a tooltip can show is reachable here
 * without a pointer, which is the only way the dot plots are readable to
 * someone who cannot hover — and, since the light-mode aqua sits under 3:1,
 * it is also the relief channel the palette validation depends on.
 */
function SolveTable({
  points,
  nameOf,
}: {
  points: BenchPoint[];
  nameOf: ReadonlyMap<string, string>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="mt-6">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="t-small text-muted underline underline-offset-4 hover:text-ink"
      >
        {open ? "Hide" : "Show"} the {points.length.toLocaleString()} plotted solves as a table
      </button>
      {open && (
        <div className="table-scroll scrollbar-slim mt-3 max-h-96 overflow-y-auto rule-t rule-b">
          <table className="w-full min-w-[38rem] border-collapse text-[12px]">
            <thead className="sticky top-0 bg-page">
              <tr className="[&>th]:rule-b">
                {["run", "puzzle", "difficulty", "seconds", "tokens", "cost"].map((h, i) => (
                  <th
                    key={h}
                    scope="col"
                    className={`t-micro px-2.5 py-1.5 text-muted ${i === 0 ? "text-left" : "text-right"}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr
                  key={`${p.run_id}:${p.idx}`}
                  className="text-muted [&:not(:first-child)>td]:rule-t"
                >
                  <td className="px-2.5 py-1 whitespace-nowrap">{nameOf.get(p.run_id) ?? p.run_id}</td>
                  <td className="t-num px-2.5 py-1 text-right">#{p.idx + 1}</td>
                  <td className="t-num px-2.5 py-1 text-right">{p.difficulty}</td>
                  <td className="t-num px-2.5 py-1 text-right text-ink">
                    {(p.wall_ms / 1000).toFixed(1)}
                  </td>
                  <td className="t-num px-2.5 py-1 text-right">
                    {solveTokens(p) == null ? "" : fmtCompact(solveTokens(p)!)}
                  </td>
                  <td className="t-num px-2.5 py-1 text-right">
                    {p.cost_micro == null ? "" : fmtUsd(microToUsd(p.cost_micro))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
