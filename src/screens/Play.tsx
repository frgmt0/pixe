import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Loader2, NotebookPen, PartyPopper } from "lucide-react";
import { encodeGrid } from "@shared/codec";
import { CELLS, EMPTY, GRID, HUE_COUNT, hueName } from "@shared/palette";
import { api, ApiError, type SolveResult } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Board, type Mirror, type Tool } from "@/game/board";
import { PixelCanvas } from "@/game/PixelCanvas";
import { Palette } from "@/game/Palette";
import { Toolbar } from "@/game/Toolbar";
import { clearDraft, usePuzzle } from "@/game/usePuzzle";
import { SolvedDialog } from "@/game/SolvedDialog";
import { cn } from "@/lib/utils";

interface Props {
  puzzleKey: string;
  signedIn: boolean;
  alreadySolved: boolean;
  onBack(): void;
  onSolved(r: SolveResult): void;
  onNeedAuth(): void;
}

export function Play({ puzzleKey, signedIn, alreadySolved, onBack, onSolved, onNeedAuth }: Props) {
  const state = usePuzzle(puzzleKey, signedIn);
  const { board, puzzle } = state;

  const [tool, setTool] = useState<Tool>("brush");
  const [brush, setBrush] = useState(4);
  const [mirror, setMirror] = useState<Mirror>("none");
  const [hue, setHue] = useState(0);
  const [showGrid, setShowGrid] = useState(false);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [notes, setNotes] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SolveResult | null>(null);

  const last = useRef<{ x: number; y: number } | null>(null);
  const rectStart = useRef<{ x: number; y: number } | null>(null);

  /* --- field notes: the player's own record, since the game keeps quiet --- */

  const notesKey = `pixe:notes:${puzzleKey}`;
  useEffect(() => setNotes(localStorage.getItem(notesKey) ?? ""), [notesKey]);
  useEffect(() => {
    const t = setTimeout(() => localStorage.setItem(notesKey, notes), 400);
    return () => clearTimeout(t);
  }, [notes, notesKey]);

  /* --- painting ---------------------------------------------------- */

  const activeHue = tool === "eraser" ? EMPTY : hue;

  const handlers = useMemo(
    () => ({
      onDown(x: number, y: number, alt: boolean) {
        if (alt || tool === "picker") {
          const v = board.grid[y * GRID + x]!;
          if (v >= 0) setHue(v);
          if (tool !== "picker") return;
          return;
        }
        board.begin();
        if (tool === "bucket") {
          board.bucket(x, y, activeHue, mirror);
        } else if (tool === "rect") {
          rectStart.current = { x, y };
        } else {
          board.paint(x, y, brush, activeHue, mirror);
        }
        last.current = { x, y };
      },
      onMove(x: number, y: number) {
        if (tool === "brush" || tool === "eraser") {
          const p = last.current ?? { x, y };
          board.stroke(p.x, p.y, x, y, brush, activeHue, mirror);
          last.current = { x, y };
        }
      },
      onUp(x: number, y: number) {
        if (tool === "rect" && rectStart.current) {
          const s = rectStart.current;
          board.rect(s.x, s.y, x, y, activeHue, mirror);
          rectStart.current = null;
        }
        last.current = null;
        if (board.commit()) state.touch();
      },
      onHover(x: number, y: number) {
        setHover({ x, y });
      },
      onLeave() {
        setHover(null);
      },
    }),
    [board, tool, brush, mirror, activeHue, state],
  );

  const mutate = useCallback(
    (fn: (b: Board) => void) => {
      board.begin();
      fn(board);
      if (board.commit()) state.touch();
    },
    [board, state],
  );

  const undo = useCallback(() => {
    if (board.undo()) state.touch();
  }, [board, state]);
  const redo = useCallback(() => {
    if (board.redo()) state.touch();
  }, [board, state]);

  /* --- keyboard ---------------------------------------------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const n = Number(e.key);
      if (n >= 1 && n <= HUE_COUNT) {
        setHue(n - 1);
        if (tool === "eraser" || tool === "picker") setTool("brush");
        return;
      }
      switch (e.key.toLowerCase()) {
        case "b": setTool("brush"); break;
        case "g": setTool("bucket"); break;
        case "r": setTool("rect"); break;
        case "e": setTool("eraser"); break;
        case "i": setTool("picker"); break;
        case "m": setMirror((m) => (m === "none" ? "x" : m === "x" ? "y" : m === "y" ? "quad" : "none")); break;
        case "[": setBrush((b) => (b <= 1 ? 1 : b === 2 ? 1 : b / 2)); break;
        case "]": setBrush((b) => Math.min(16, b === 1 ? 2 : b * 2)); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, tool]);

  /* --- counts ------------------------------------------------------ */

  const counts = useMemo(() => {
    const c = new Int32Array(HUE_COUNT);
    for (let i = 0; i < CELLS; i++) {
      const v = board.grid[i]!;
      if (v >= 0) c[v]!++;
    }
    return c;
    // Recomputed whenever the board changes; version is the change signal.
  }, [board, state.version]);

  /* --- submit ------------------------------------------------------ */

  const submit = async () => {
    if (!signedIn) return onNeedAuth();
    setSubmitting(true);
    setError(null);
    try {
      const r = await api.solve(puzzleKey, encodeGrid(board.grid));
      setResult(r);
      onSolved(r);
      clearDraft(puzzleKey);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not submit. Try again?");
    } finally {
      setSubmitting(false);
    }
  };

  const pct = Math.round((state.filled / CELLS) * 100);
  const bad = state.badCells.size;
  const ready = state.solved;

  return (
    <div className="mx-auto w-full max-w-350 px-4 pb-10">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" strokeWidth={3} /> Puzzles
        </Button>
        <div className="min-w-0">
          <h1 className="truncate font-display text-xl leading-tight">{puzzle.title}</h1>
          <p className="text-xs font-bold text-ink-faint">
            {puzzleKey.startsWith("D") ? `Daily · ${puzzleKey.slice(1)}` : `Puzzle #${puzzleKey.slice(1)}`}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {alreadySolved && <Badge variant="good">Solved</Badge>}
          <Badge variant="ink">{puzzle.points} pts</Badge>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* ---------------- canvas ---------------- */}
        <div className="min-w-0">
          <div className="mx-auto w-full max-w-[min(78vh,52rem)]">
            {state.loading ? (
              <div className="grid aspect-square w-full place-items-center rounded-xl ink-border bg-cloth shadow-chunk-lg">
                <Loader2 className="size-8 animate-spin text-paper/60" />
              </div>
            ) : (
              <PixelCanvas
                grid={board.grid}
                version={state.version}
                badCells={state.badCells}
                tool={tool}
                brush={brush}
                mirror={mirror}
                hue={hue}
                showGrid={showGrid}
                handlers={handlers}
              />
            )}

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-bold text-ink-soft">
              <span className="tabular-nums">
                {hover ? `x ${hover.x}, y ${hover.y}` : `${GRID}×${GRID}`}
              </span>
              <span className="tabular-nums">{state.filled} / {CELLS} filled</span>
              {bad > 0 && (
                <span className="tabular-nums text-bad">
                  {bad} cell{bad === 1 ? "" : "s"} unhappy
                </span>
              )}
              {state.hotHues.size > 0 && (
                <span className="text-bad">
                  {[...state.hotHues].map(hueName).join(", ")} restless
                </span>
              )}
              {puzzle.bonds.length > 0 && (
                <span className="ml-auto tabular-nums">
                  bonds {state.bonds}
                  <span className="text-ink-faint"> / par {puzzle.parBonds}</span>
                </span>
              )}
            </div>
          </div>
        </div>

        {/* ---------------- side panel ---------------- */}
        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:self-start">
          <Palette hue={hue} onPick={(h) => { setHue(h); if (tool === "eraser" || tool === "picker") setTool("brush"); }} counts={counts} hot={state.hotHues} />

          <Toolbar
            tool={tool}
            setTool={setTool}
            brush={brush}
            setBrush={setBrush}
            mirror={mirror}
            setMirror={setMirror}
            showGrid={showGrid}
            setShowGrid={setShowGrid}
            canUndo={board.canUndo}
            canRedo={board.canRedo}
            onUndo={undo}
            onRedo={redo}
            onClear={() => mutate((b) => b.clear())}
          />

          {/* Nothing here explains the laws. It is a place to write down what
              you worked out yourself — the game never tells you. */}
          <div>
            <button
              type="button"
              onClick={() => setNotesOpen((v) => !v)}
              className="mb-1.5 flex w-full items-center gap-1 font-display text-sm uppercase tracking-wide text-ink-soft"
            >
              <NotebookPen className="size-3.5" strokeWidth={2.5} />
              Field notes
              <span className="ml-auto text-[11px]">{notesOpen ? "hide" : "show"}</span>
            </button>
            {notesOpen && (
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                spellCheck={false}
                placeholder={"what have you worked out?\n\ne.g. banana hates grape\nleft side won't take mint"}
                className="h-40 w-full resize-y rounded-xl ink-border bg-white p-3 text-sm font-semibold leading-relaxed shadow-chunk-sm placeholder:font-medium placeholder:text-ink-faint focus:outline-none"
              />
            )}
          </div>

          <div className="rounded-2xl ink-border bg-paper-2 p-3 shadow-chunk">
            <div className="mb-2 h-4 w-full overflow-hidden rounded-full border-[2.5px] border-ink bg-white">
              <div
                className={cn("h-full transition-[width] duration-300", ready ? "bg-good" : "bg-pop")}
                style={{ width: `${pct}%` }}
              />
            </div>
            <Button
              variant={ready ? "good" : "default"}
              className="w-full"
              disabled={!ready || submitting || state.loading}
              onClick={submit}
            >
              {submitting ? (
                <Loader2 className="size-5 animate-spin" />
              ) : ready ? (
                <>
                  <PartyPopper className="size-5" strokeWidth={2.5} /> Submit for {puzzle.points} pts
                </>
              ) : state.filled === CELLS ? (
                "Something is still wrong"
              ) : (
                `${CELLS - state.filled} squares to go`
              )}
            </Button>
            {error && <p className="mt-2 text-center text-xs font-bold text-bad">{error}</p>}
            {!signedIn && (
              <p className="mt-2 text-center text-[11px] font-bold text-ink-faint">
                Sign in to bank your points.
              </p>
            )}
          </div>
        </div>
      </div>

      {result && (
        <SolvedDialog
          result={result}
          puzzle={puzzle}
          grid={board.grid}
          onClose={() => setResult(null)}
          onBack={onBack}
        />
      )}
    </div>
  );
}
