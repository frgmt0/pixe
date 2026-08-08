import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import type { BenchGroupRow as WireBenchGroupRow } from "@shared/protocol";
import { fmtDuration, fmtDurationLong, runLabel, toBenchRow, type BenchRow } from "@/lib/bench";
import { BenchTable } from "@/components/charts/BenchTable";
import { ChartTokens } from "@/components/charts/theme";

/**
 * The benchmark screen.
 *
 * `/api/bench` returns one row per model now, not one row per run — a run is
 * crowd-sourced, a model is the thing being ranked, and the ladder is a fixed
 * 500 brutally hard boards (multi-phase on its upper rungs). So `solves`, out
 * of that fixed 500, is the headline a reader should take away, with pace as
 * the tiebreak: how far a model got on a ladder every entrant finds hard
 * before how fast it went. The table carries the rest — the learning curve
 * lives inside each row now, one click away, rather than as a
 * pick-three-runs comparison at the top of the page.
 */

interface BenchPayload {
  rows: WireBenchGroupRow[];
  universe: number;
  pointsConsidered: number;
  truncated: boolean;
}

export function Bench() {
  const [bench, setBench] = useState<BenchPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/bench")
      .then((r) => r.json() as Promise<BenchPayload>)
      .then((b) => live && setBench(b))
      .catch(() => live && setError("Couldn't load the benchmark."));
    return () => {
      live = false;
    };
  }, []);

  const universe = bench?.universe || 500;
  const rows: BenchRow[] = useMemo(
    () => (bench?.rows ?? []).map((w) => toBenchRow(w, universe)),
    [bench, universe],
  );

  // The default sort — most progress, pace as the tiebreak — is what the
  // server already returns rows in, so the leader is simply the first row.
  const leader = rows[0];
  const totalSolves = rows.reduce((a, r) => a + r.solves, 0);
  const verifiedCount = rows.filter((r) => r.verified).length;
  const totalRuns = rows.reduce((a, r) => a + r.runs, 0);

  if (error) {
    return (
      <div className="viz-root mx-auto w-full max-w-6xl px-5 py-16">
        <ChartTokens />
        <p className="text-center text-bad">{error}</p>
      </div>
    );
  }

  if (!bench) {
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

      {/* Title, with the shape of the benchmark stated beside it as data:
          labels left in muted mono, values right in ink mono, a hairline
          underneath. */}
      <header className="flex flex-col gap-6 pt-2 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-xl">
          <h1 className="t-display">The pixe benchmark</h1>
          <p className="mt-3 text-muted">
            Every run is issued one puzzle at a time from a fixed 500-board ladder; the next key
            is derived from the verified solution to the last. Runs are crowd-sourced with the pi
            runner script — a <span className="text-ink">verified</span> badge marks the handful
            registered from the maintainer's own machine. Progress on the ladder is the headline;
            effective time per solve only ever breaks a tie.
          </p>
        </div>
        <dl className="shrink-0 t-num text-[11px] sm:min-w-44">
          <Fact label="models" value={rows.length.toLocaleString()} />
          <Fact
            label="runs"
            value={totalRuns.toLocaleString()}
            note={verifiedCount ? `${verifiedCount} verified` : undefined}
          />
          <Fact
            label="solves"
            value={totalSolves.toLocaleString()}
            note={bench.truncated ? "recent window" : undefined}
          />
          <Fact label="ladder" value={universe.toLocaleString()} />
        </dl>
      </header>

      {rows.length === 0 ? (
        <p className="rule-t py-20 text-center text-muted">No model has banked a solve yet.</p>
      ) : (
        <>
          {/* The number the page exists to report: how far the leading model
              got on a fixed, brutal ladder. */}
          <section className="rule-t rule-b py-7">
            <p className="t-micro text-muted">Ladder leader, solves of {universe.toLocaleString()}</p>
            {/* Sans, not mono. Mono is for figures sitting in a column where
                alignment is the point; this is a headline and both references
                set display type in the text face. Tabular so the digits still
                have even colour. */}
            <p className="mt-2 text-[44px] leading-none tracking-[-0.03em] tabular-nums">
              {leader!.solves.toLocaleString()}
              <span className="text-muted"> / {universe.toLocaleString()}</span>
            </p>
            <p className="mt-2.5 max-w-xl text-muted">
              <span className="text-ink">{runLabel(leader!)}</span> at{" "}
              <span className="t-num text-ink">{fmtDuration(leader!.effective_ms_per_solve)}</span>{" "}
              per solve including abandoned boards, held serially — projected{" "}
              <span className="t-num text-ink">{fmtDurationLong(leader!.projected_500_hours)}</span> to
              clear the whole ladder at that pace.
              {leader!.complete && " The ladder is cleared."}
            </p>
          </section>

          <section className="mt-10">
            <h2 className="t-title mb-3">Every model</h2>
            <BenchTable rows={rows} universe={universe} />
          </section>
        </>
      )}
    </div>
  );
}

/** One row of the hero key/value block. The note is a qualifier on the
 *  number, not a separate figure, so it trails the value in parentheses
 *  rather than sitting in front where it can be misread as another count. */
function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-0.5">
      <dt className="text-muted">{label}</dt>
      <dd className="text-ink">
        {value}
        {note && <span className="ml-1.5 text-muted">({note})</span>}
      </dd>
    </div>
  );
}
