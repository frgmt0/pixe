import { useMemo, useState } from "react";
import { byEffectiveTime, byProbes } from "@shared/protocol";
import {
  fmtCompact,
  fmtDurationLong,
  fmtHours,
  fmtRate,
  fmtSeconds,
  fmtUsd,
  microToUsd,
  runLabel,
  type BenchRow,
} from "@/lib/bench";
import { seriesVar } from "./theme";

/**
 * The benchmark table.
 *
 * Three decisions carry the whole thing, and the redesign kept all three while
 * changing how each is drawn.
 *
 * 1. **Declared and measured are visually separated.** They used to be told
 *    apart by a background tint. This palette has no fills to spend, so the
 *    distinction is now carried by three redundant signals instead of one: a
 *    group header in the label register, a vertical hairline at each group
 *    boundary that runs the full height of the table, and colour — measured
 *    columns are set in ink, declared columns in muted. That is deliberately
 *    more redundancy than before, because it is the most important thing on the
 *    page after the numbers themselves and it now has to survive on a surface
 *    with nothing but hairlines on it.
 * 2. **Time is the spine.** Effective seconds per solve and the projected wall
 *    clock to 1M are the only two cells set in ink at the larger step. On
 *    DeepSWE only the headline metric is dark and every supporting figure is
 *    grey; that is exactly the reading order this table wants.
 * 3. **The abandon count sits immediately beside them,** because a quick median
 *    next to a pile of dropped boards is the signature of board-shopping and a
 *    reader should be able to see that without anyone having to build a
 *    detector.
 *
 * Probes per solve is measured and therefore sits inside the measured group,
 * next to the clock rather than anywhere near the declared columns. It is the
 * second ranking the table offers, and the two are not interchangeable: probes
 * measure deduction and are capacity-independent, time measures throughput and
 * is not. Both comparators come from `shared/protocol.ts`, which is also what
 * `/api/bench` sorts with — the reader toggling a column must not be able to
 * get a different answer from the same rows.
 *
 * The provenance row now says three things rather than two, because the run's
 * identity is neither measured nor self-declared: a human vouched for the
 * harness at pairing. `config` rides under it as a subtitle and is prose about
 * the setup — never a column of its own, never sorted, because a sortable
 * column of those strings would read as a model leaderboard, and a harness
 * driving subagents is not running one model to rank.
 *
 * The table scrolls inside its own container. It has twelve columns and the
 * page must never scroll sideways because of it.
 */

type SortKey =
  | "effective_ms_per_solve"
  | "probes_per_solve"
  | "median_wall_ms"
  | "abandon_rate"
  | "solved"
  | "tokens_per_solve"
  | "cost_per_solve_micro";

interface Props {
  rows: BenchRow[];
  /** Runs currently drawn in the charts, so the table and the plots agree. */
  plotted: ReadonlyMap<string, number>;
  onToggle(runId: string): void;
}

/** The vertical hairline that opens a column group. */
const EDGE = "rule-l";

export function BenchTable({ rows, plotted, onToggle }: Props) {
  const [sort, setSort] = useState<SortKey>("effective_ms_per_solve");

  const sorted = useMemo(() => {
    const copy = [...rows];
    const base = byEffectiveTime;
    copy.sort((a, b) => {
      if (sort === "effective_ms_per_solve") return base(a, b);
      // The two rankings the benchmark actually publishes, shared with the
      // endpoint rather than reimplemented here.
      if (sort === "probes_per_solve") return byProbes(a, b);
      if (sort === "median_wall_ms") return a.median_wall_ms - b.median_wall_ms;
      if (sort === "abandon_rate") return b.abandon_rate - a.abandon_rate || base(a, b);
      // Nulls last on every declared column: a run that reported nothing has
      // not scored badly, it has simply not said, and sorting it to the bottom
      // of a "cheapest" list would read as the opposite.
      const av = a[sort];
      const bv = b[sort];
      if (av == null && bv == null) return base(a, b);
      if (av == null) return 1;
      if (bv == null) return -1;
      return sort === "cost_per_solve_micro" ? av - bv : bv - av;
    });
    return copy;
  }, [rows, sort]);

  return (
    <div>
      <div className="table-scroll scrollbar-slim rule-t rule-b">
        <table className="w-full min-w-[62rem] border-collapse text-[12px]">
          <thead>
            {/* The provenance row. It is the caveat, said once, at the top —
                rather than glued to every cell. */}
            <tr>
              <th colSpan={2} className="t-micro px-2.5 pt-2.5 pb-1 text-left text-muted">
                vouched by a human
              </th>
              <th colSpan={7} className={`t-micro px-2.5 pt-2.5 pb-1 text-left text-ink ${EDGE}`}>
                measured by pixe
              </th>
              <th colSpan={3} className={`t-micro px-2.5 pt-2.5 pb-1 text-left text-muted ${EDGE}`}>
                declared by the run
              </th>
            </tr>
            <tr className="[&>th]:rule-b">
              <Th declared>plot</Th>
              <Th declared align="left">harness</Th>
              <Th edge sortKey="solved" sort={sort} onSort={setSort}>solved</Th>
              <Th sortKey="abandon_rate" sort={sort} onSort={setSort}>abandoned</Th>
              <Th sortKey="effective_ms_per_solve" sort={sort} onSort={setSort} strong>
                effective&nbsp;/&nbsp;solve
              </Th>
              {/* Not `strong`: the spine is time, and two headings in ink at
                  the same weight would read as two headline metrics. Probes is
                  measured and ranks, so it takes ink in the body cell and the
                  ordinary muted head until it is the active sort. */}
              <Th sortKey="probes_per_solve" sort={sort} onSort={setSort}>
                probes&nbsp;/&nbsp;solve
              </Th>
              <Th sortKey="median_wall_ms" sort={sort} onSort={setSort}>median solved</Th>
              <Th>p90</Th>
              <Th strong>time to 1M</Th>
              <Th edge declared sortKey="tokens_per_solve" sort={sort} onSort={setSort}>
                tokens&nbsp;/&nbsp;solve
              </Th>
              <Th declared sortKey="cost_per_solve_micro" sort={sort} onSort={setSort}>
                cost&nbsp;/&nbsp;solve
              </Th>
              <Th declared>cost to 1M</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const slot = plotted.get(r.run_id);
              return (
                <tr key={r.run_id} className="align-middle [&:not(:first-child)>td]:rule-t">
                  <td className="px-2.5 py-1.5">
                    <button
                      type="button"
                      onClick={() => onToggle(r.run_id)}
                      aria-pressed={slot !== undefined}
                      title={slot !== undefined ? "Remove from the charts" : "Show in the charts"}
                      className="grid size-3.5 place-items-center rounded-full rule-all transition-colors"
                      style={{
                        borderColor: slot === undefined ? "var(--rule)" : seriesVar(slot),
                        background: slot === undefined ? "transparent" : seriesVar(slot),
                      }}
                    >
                      <span className="sr-only">
                        {slot !== undefined ? "Plotted" : "Not plotted"}: {runLabel(r)}
                      </span>
                    </button>
                  </td>
                  {/* Harness in ink, the run's own note about its setup under
                      it in muted. A run that gave no note gets no second line —
                      not a dash, which would read as a value. */}
                  <Td className="max-w-64">
                    <span className="block whitespace-nowrap">{runLabel(r)}</span>
                    {/* Capped and clipped rather than allowed to set the column
                        width: config is free prose up to 48 characters, and one
                        verbose run should not push the measured columns off the
                        edge for every other row. The full string is the title. */}
                    {r.config && (
                      <span className="block truncate text-[11px] text-muted" title={r.config}>
                        {r.config}
                      </span>
                    )}
                  </Td>
                  <Td edge num>{r.solved.toLocaleString()}</Td>
                  <Td num soft={r.abandoned === 0}>
                    <span title={`${r.abandoned} boards abandoned out of ${r.abandoned + r.solved} issued`}>
                      {r.abandoned === 0 ? "none" : `${r.abandoned} · ${fmtRate(r.abandon_rate)}`}
                    </span>
                  </Td>
                  <Td num strong>{fmtSeconds(r.effective_ms_per_solve)}</Td>
                  <Td num>
                    <span title={`${r.probes_per_solve} looks at the board per banked solve`}>
                      {fmtProbes(r.probes_per_solve)}
                    </span>
                  </Td>
                  <Td num soft>{fmtSeconds(r.median_wall_ms)}</Td>
                  <Td num soft>{fmtSeconds(r.p90_wall_ms)}</Td>
                  <Td num strong>
                    <span title={`${Math.round(r.projected_1m_hours).toLocaleString()} hours`}>
                      {fmtDurationLong(r.projected_1m_hours)}
                    </span>
                  </Td>
                  <Td edge declared num>
                    {r.tokens_per_solve == null ? (
                      <Blank />
                    ) : (
                      <Reported
                        value={fmtCompact(r.tokens_per_solve)}
                        of={r.tokens_reported}
                        solved={r.solved}
                      />
                    )}
                  </Td>
                  <Td declared num>
                    {r.cost_per_solve_micro == null ? (
                      <Blank />
                    ) : (
                      <Reported
                        value={fmtUsd(microToUsd(r.cost_per_solve_micro))}
                        of={r.cost_reported}
                        solved={r.solved}
                      />
                    )}
                  </Td>
                  <Td declared num>
                    {r.projected_1m_cost_usd == null ? <Blank /> : fmtUsd(r.projected_1m_cost_usd)}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 max-w-3xl t-small text-muted">
        <span className="text-ink">Effective / solve</span> is every second the run held a board —
        abandoned boards included — divided by the boards it banked. It is the ranking and the basis
        of the projection, because an agent that drops anything hard and keeps only the easy boards
        would otherwise post a flattering median.{" "}
        <span className="text-ink">Median solved</span> is the honest answer to how fast it goes when
        it lands, and it is what the learning curve plots.{" "}
        <span className="text-ink">Probes / solve</span> is the other ranking, and it answers a
        different question: probes measure deduction and are capacity-independent, time measures
        throughput and is not. A slow provider changes how long an agent takes, never how many times
        it had to look at the board before it knew the answer. Sort by either. Projections are{" "}
        <span className="text-ink">serial</span> — one agent, one board at a time, held for a million
        puzzles
        {rows[0] && ` (${fmtHours(rows[0].projected_1m_hours)} for the current leader)`}. Time,
        probe counts and solve validity are measured here; the harness is a human's word and the
        setup note under it is the run's own, ranked by nothing. Token counts are whatever the run
        says they are, and nothing on this page is ranked on a declared number.
      </p>
    </div>
  );
}

function Th({
  children,
  align = "right",
  declared,
  strong,
  edge,
  sortKey,
  sort,
  onSort,
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
  declared?: boolean;
  strong?: boolean;
  /** Opens a column group: takes the vertical hairline. */
  edge?: boolean;
  sortKey?: SortKey;
  sort?: SortKey;
  onSort?: (k: SortKey) => void;
}) {
  const active = sortKey !== undefined && sortKey === sort;
  return (
    <th
      scope="col"
      className={[
        "t-micro px-2.5 pb-1.5 whitespace-nowrap",
        align === "left" ? "text-left" : "text-right",
        strong || active ? "text-ink" : declared ? "text-muted" : "text-muted",
        edge ? EDGE : "",
      ].join(" ")}
      aria-sort={active ? "ascending" : undefined}
    >
      {sortKey && onSort ? (
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          className="underline-offset-3 hover:underline"
        >
          {children}
          {active ? " ↓" : ""}
        </button>
      ) : (
        children
      )}
    </th>
  );
}

function Td({
  children,
  className = "",
  declared,
  num,
  soft,
  strong,
  edge,
}: {
  children?: React.ReactNode;
  className?: string;
  declared?: boolean;
  num?: boolean;
  soft?: boolean;
  strong?: boolean;
  edge?: boolean;
}) {
  return (
    <td
      className={[
        "px-2.5 py-1.5",
        num ? "t-num text-right whitespace-nowrap" : "",
        // The spine. One step up in size and the only cells in full ink.
        strong ? "text-[13px] text-ink" : soft || declared ? "text-muted" : "text-ink",
        edge ? EDGE : "",
        className,
      ].join(" ")}
    >
      {children}
    </td>
  );
}

/**
 * A mean of small integers, so one decimal or none — `6.4`, `12`. Zero is a
 * real reading here and not a missing one: it is a board deduced without ever
 * having to look at how the grid reacted.
 */
const fmtProbes = (n: number): string => (Number.isInteger(n) ? `${n}` : n.toFixed(1));

/** Not a zero and not a dash-as-value: this run simply did not say. */
const Blank = () => (
  <span aria-label="not reported" title="This run reported no figure." className="text-muted/45">
    ·
  </span>
);

/**
 * A mean over some of the solves is a different number from a mean over all of
 * them, so the coverage rides along with the figure rather than living in a
 * footnote nobody reads. DeepSWE does the same thing with its ±confidence
 * interval: the qualifier sits directly beside the number, one register down.
 */
function Reported({ value, of, solved }: { value: string; of: number; solved: number }) {
  return (
    <span title={`Reported on ${of} of ${solved} solves`}>
      {value}
      {of < solved && <span className="text-muted/60"> ({of}/{solved})</span>}
    </span>
  );
}
