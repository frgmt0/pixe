import { useEffect, useState } from "react";
import { Loader2, Trophy } from "lucide-react";
import { api, type LeaderRow } from "@/lib/api";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const MEDALS = ["🥇", "🥈", "🥉"];

export function Leaderboard({ open, onClose, me }: { open: boolean; onClose(): void; me?: string }) {
  const [rows, setRows] = useState<LeaderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRows(null);
    setError(null);
    api
      .leaderboard()
      .then((r) => setRows(r.rows))
      .catch(() => setError("Couldn't load the board."));
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(94vw,34rem)]">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Trophy className="size-6 text-pop" strokeWidth={2.5} />
            <DialogTitle>Hall of Grids</DialogTitle>
          </div>
          <DialogDescription>Points come from solving puzzles. Harder puzzles, more points.</DialogDescription>
        </DialogHeader>

        <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto p-4">
          {error && <p className="py-8 text-center font-bold text-bad">{error}</p>}
          {!rows && !error && (
            <div className="grid place-items-center py-12">
              <Loader2 className="size-7 animate-spin text-ink-faint" />
            </div>
          )}
          {rows?.length === 0 && (
            <p className="py-10 text-center font-bold text-ink-soft">
              Nobody has solved anything yet. Be the legend.
            </p>
          )}
          {rows && rows.length > 0 && (
            <ol className="flex flex-col gap-1.5">
              {rows.map((r, i) => (
                <li
                  key={r.name}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border-[2.5px] border-ink px-3 py-2",
                    r.name === me ? "bg-pop" : i < 3 ? "bg-paper-2" : "bg-white",
                  )}
                >
                  <span className="w-8 shrink-0 text-center font-display text-base tabular-nums">
                    {MEDALS[i] ?? i + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-display text-base">{r.name}</span>
                  <span className="shrink-0 text-xs font-bold tabular-nums text-ink-soft">
                    {r.solved} solved
                  </span>
                  <span className="w-14 shrink-0 text-right font-display text-lg tabular-nums">
                    {r.score}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
