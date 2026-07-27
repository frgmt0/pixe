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
 */
export function Palette({ hue, onPick, counts, hot }: Props) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="font-display text-sm uppercase tracking-wide text-ink-soft">Paint</h2>
        <span className="text-[11px] font-bold text-ink-faint">1–8 or [ ]</span>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {HUES.map((h) => {
          const selected = hue === h.id;
          const buzzing = hot.has(h.id);
          return (
            <button
              key={h.id}
              type="button"
              onClick={() => onPick(h.id)}
              title={`${h.name} — ${counts[h.id] ?? 0} cells`}
              aria-label={`${h.name}, ${counts[h.id] ?? 0} cells${buzzing ? ", something is off with this colour" : ""}`}
              aria-pressed={selected}
              className={cn(
                "group relative flex aspect-square flex-col items-center justify-center rounded-xl ink-border transition-transform",
                selected ? "shadow-chunk -translate-y-0.5 scale-105" : "shadow-chunk-sm hover:-translate-y-0.5",
                buzzing && "animate-buzz",
              )}
              style={{ backgroundColor: h.hex }}
            >
              <span className="text-lg leading-none drop-shadow-sm">{h.emoji}</span>
              <span className="mt-0.5 rounded bg-ink/75 px-1 text-[10px] font-bold leading-4 text-white tabular-nums">
                {counts[h.id] ?? 0}
              </span>
              {selected && (
                <span className="pointer-events-none absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full ink-border bg-ink text-[10px] leading-none text-paper">
                  ✓
                </span>
              )}
              {buzzing && (
                <span className="pointer-events-none absolute -left-1.5 -top-1.5 grid size-5 place-items-center rounded-full border-2 border-ink bg-bad text-[11px] leading-none text-white">
                  !
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
