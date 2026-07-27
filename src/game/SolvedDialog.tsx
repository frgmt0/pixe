import { useEffect, useState } from "react";
import { Check, Copy, Download, Sparkles } from "lucide-react";
import type { Puzzle } from "@shared/generate";
import { bondText, ruleText, type Grid } from "@shared/rules";
import type { SolveResult } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Confetti } from "@/components/Confetti";
import { downloadPoster, gridToDataUrl } from "./exportArt";

interface Props {
  result: SolveResult;
  puzzle: Puzzle;
  grid: Grid;
  onClose(): void;
  onBack(): void;
}

const CHEERS = [
  "Absolutely unreasonable behaviour.",
  "You did the thing!",
  "The laws have been obeyed. Barely.",
  "Certified grid enjoyer.",
  "Nobody taught you that. You just knew.",
  "That's the good stuff.",
];

/**
 * The only place rule text ever appears. Revealing the laws you just beat is
 * the payoff for solving them blind — and it can't help you, because it only
 * shows up after the puzzle is already won.
 */
export function SolvedDialog({ result, puzzle, grid, onClose, onBack }: Props) {
  const [copied, setCopied] = useState(false);
  const preview = useState(() => gridToDataUrl(grid, 6))[0];
  const cheer = useState(() => CHEERS[Math.floor(Math.random() * CHEERS.length)]!)[0];

  const shareUrl = `${location.origin}/a/${result.shareId}`;

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
    } catch {
      window.prompt("Copy your link:", shareUrl);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(94vw,46rem)]">
        <Confetti />
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Sparkles className="size-6 text-pop-2" strokeWidth={2.5} />
            <DialogTitle>{result.alreadySolved ? "Already in the books" : "Solved!"}</DialogTitle>
          </div>
          <DialogDescription>{result.alreadySolved ? "You'd cracked this one before, so no extra points — but the art is yours." : cheer}</DialogDescription>
        </DialogHeader>

        <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto p-5">
          <div className="flex flex-wrap items-start gap-5">
            <img
              src={preview}
              alt="Your finished artwork"
              width={192}
              height={192}
              className="pixelated size-48 shrink-0 rounded-xl ink-border shadow-chunk"
            />
            <div className="min-w-45 flex-1">
              <div className="mb-3 flex flex-wrap gap-2">
                <Badge variant="ink">+{result.points} pts</Badge>
                <Badge variant="plain">{result.stats.score} total</Badge>
                <Badge variant="plain">{result.stats.solved} solved</Badge>
                {puzzle.bonds.length > 0 && (
                  <Badge variant={result.bonds >= puzzle.parBonds ? "good" : "plain"}>
                    {result.bonds} bonds · par {puzzle.parBonds}
                  </Badge>
                )}
              </div>
              {puzzle.bonds.length > 0 && (
                <p className="mb-3 text-xs font-bold text-ink-soft">
                  Bonded pairs: {puzzle.bonds.map(bondText).join(" · ")}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={copy}>
                  {copied ? <Check className="size-4" strokeWidth={3} /> : <Copy className="size-4" strokeWidth={3} />}
                  {copied ? "Copied!" : "Copy link"}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    downloadPoster(
                      grid,
                      {
                        title: puzzle.title,
                        author: result.user.name,
                        subtitle: puzzle.key.startsWith("D") ? `Daily ${puzzle.key.slice(1)}` : `Puzzle #${puzzle.key.slice(1)}`,
                      },
                      `pixe-${puzzle.key}-${result.user.name}.png`,
                    )
                  }
                >
                  <Download className="size-4" strokeWidth={3} /> PNG
                </Button>
              </div>
            </div>
          </div>

          <h3 className="mt-6 font-display text-lg">What you were actually up against</h3>
          <p className="mb-3 text-xs font-bold text-ink-faint">
            {puzzle.rules.length} hidden laws. You never got told any of them.
          </p>
          <ul className="flex flex-col gap-2">
            {puzzle.rules.map((r, i) => (
              <li
                key={i}
                className="rounded-xl border-[2.5px] border-ink bg-white px-3 py-2 text-sm font-semibold leading-snug"
              >
                {ruleText(r, puzzle.scheme)}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex gap-2 border-t-3 border-ink p-4">
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            Keep looking at it
          </Button>
          <Button className="flex-1" onClick={onBack}>
            Next puzzle →
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
