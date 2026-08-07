import { HUES } from "@shared/palette";
import { cn } from "@/lib/utils";

interface Props {
  hue: number;
  onPick(hue: number): void;
  counts: Int32Array;
  /** Hues whose counting rules are currently unsatisfied. See RuleEval.hue. */
  hot: Set<number>;
}

/**
 * Counting rules (quotas, per-row limits) have no guilty cell to light up on
 * the canvas, so the swatch itself reacts instead. It never says what is
 * wrong — only that this colour is involved — which keeps the "figure it out
 * yourself" contract intact while making sure no failure is ever invisible.
 *
 * The redesign strips the swatches back to flat colour chips: the eight hues
 * are the only saturated thing in the product now, and they were previously
 * competing with a 3px ink border, a hard shadow, an emoji and a tick badge.
 * Two states survive, because both are information rather than decoration —
 * *selected* (an ink ring outside the chip) and *buzzing* (the shiver, plus a
 * ring in the status colour so the signal is not motion-alone).
 */
export function Palette({ hue, onPick, counts, hot }: Props) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="t-micro text-muted">Paint</h2>
        <span className="t-num text-[10px] text-muted">1–8 · [ ]</span>
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {HUES.map((h) => {
          const selected = hue === h.id;
          const buzzing = hot.has(h.id);
          return (
            <button
              key={h.id}
              type="button"
              onClick={() => onPick(h.id)}
              title={`${h.name} — ${counts[h.id] ?? 0} cells`}
              /* The solver reads this string. Do not reword the buzz clause. */
              aria-label={`${h.name}, ${counts[h.id] ?? 0} cells${buzzing ? ", something is off with this colour" : ""}`}
              aria-pressed={selected}
              className={cn(
                "group relative flex aspect-square flex-col items-center justify-end rounded-[3px] pb-1 transition-shadow",
                // An outside ring, so the chip's own colour is never overpainted.
                selected && "ring-1 ring-ink ring-offset-2 ring-offset-page",
                buzzing && "animate-buzz ring-1 ring-bad ring-offset-1 ring-offset-page",
              )}
              style={{ backgroundColor: h.hex }}
            >
              {/* The count reads over eight different hues, so it carries its
                  own scrim rather than trusting any one of them. */}
              <span className="t-num rounded-[2px] bg-black/45 px-1 text-[9px] leading-[13px] text-white">
                {counts[h.id] ?? 0}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
