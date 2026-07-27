import { useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Lock } from "lucide-react";
import { dailyKey, generatePuzzle, ladderKey } from "@shared/generate";
import { HUES } from "@shared/palette";
import type { SolveSummary } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  solves: SolveSummary[];
  onOpen(key: string): void;
}

const PAGE = 12;

export function Ladder({ solves, onOpen }: Props) {
  const [page, setPage] = useState(0);
  const solved = useMemo(() => new Set(solves.map((s) => s.key)), [solves]);
  const today = dailyKey();

  const keys = useMemo(
    () => Array.from({ length: PAGE }, (_, i) => ladderKey(page * PAGE + i + 1)),
    [page],
  );

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-16">
      <section className="mb-8">
        <h2 className="mb-3 font-display text-sm uppercase tracking-wide text-ink-soft">Today only</h2>
        <button
          type="button"
          onClick={() => onOpen(today)}
          className="group flex w-full items-center gap-4 rounded-2xl ink-border bg-pop-2 p-4 text-left shadow-chunk chunk"
        >
          <CalendarDays className="size-8 shrink-0 text-ink" strokeWidth={2.5} />
          <div className="min-w-0 flex-1">
            <p className="font-display text-xl leading-tight">The Daily Grid</p>
            <p className="truncate text-sm font-bold text-ink/70">
              Same puzzle for everyone, until midnight UTC.
            </p>
          </div>
          {solved.has(today) ? <Badge variant="good">Done</Badge> : <Badge variant="ink">Open</Badge>}
        </button>
      </section>

      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-sm uppercase tracking-wide text-ink-soft">The ladder</h2>
        <div className="flex items-center gap-2">
          <Button
            size="icon-sm"
            variant="secondary"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            aria-label="Previous page"
          >
            <ChevronLeft className="size-4" strokeWidth={3} />
          </Button>
          <span className="min-w-16 text-center text-sm font-bold tabular-nums text-ink-soft">
            {page * PAGE + 1}–{page * PAGE + PAGE}
          </span>
          <Button
            size="icon-sm"
            variant="secondary"
            onClick={() => setPage((p) => p + 1)}
            aria-label="Next page"
          >
            <ChevronRight className="size-4" strokeWidth={3} />
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {keys.map((key, i) => (
          <PuzzleCard key={key} puzzleKey={key} index={page * PAGE + i + 1} solved={solved.has(key)} onOpen={onOpen} />
        ))}
      </div>

      <p className="mt-8 text-center text-sm font-bold text-ink-faint">
        The ladder never ends. Neither does your free time.
      </p>
    </div>
  );
}

function PuzzleCard({
  puzzleKey,
  index,
  solved,
  onOpen,
}: {
  puzzleKey: string;
  index: number;
  solved: boolean;
  onOpen(key: string): void;
}) {
  // Generating here is ~5ms and cached thereafter, so a page of twelve is
  // cheap enough to do inline rather than round-tripping to the server.
  const puzzle = useMemo(() => generatePuzzle(puzzleKey), [puzzleKey]);

  return (
    <button
      type="button"
      onClick={() => onOpen(puzzleKey)}
      className={cn(
        "flex flex-col gap-3 rounded-2xl ink-border p-4 text-left shadow-chunk chunk",
        solved ? "bg-good/15" : "bg-paper",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-bold text-ink-faint">#{index}</p>
          <p className="truncate font-display text-lg leading-tight">{puzzle.title}</p>
        </div>
        <Badge variant={solved ? "good" : "ink"}>{solved ? "✓" : `${puzzle.points}pt`}</Badge>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex -space-x-1">
          {puzzle.hueSet.slice(0, 8).map((h) => (
            <span
              key={h}
              className="size-5 rounded-full border-2 border-ink"
              style={{ backgroundColor: HUES[h]!.hex }}
            />
          ))}
        </div>
        {/* Deliberately not the real count — knowing how many laws exist tells
            you when to stop hunting, and nothing here should do that. */}
        <span className="ml-auto flex items-center gap-1 text-xs font-bold text-ink-faint">
          <Lock className="size-3" strokeWidth={3} />
          ??? laws
        </span>
      </div>
    </button>
  );
}
