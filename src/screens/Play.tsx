import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Loader2, NotebookPen, PartyPopper, Sparkles } from "lucide-react";
import { CELLS, EMPTY, GRID, HUE_COUNT, hueName } from "@shared/palette";
import { ruleText } from "@shared/rules";
import {
  api,
  ApiError,
  type Banked,
  type Issue,
  type Pairing,
  type RunMe,
  type RunSummary,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Confetti } from "@/components/Confetti";
import { Board, type Mirror, type Tool } from "@/game/board";
import { PixelCanvas } from "@/game/PixelCanvas";
import { Palette } from "@/game/Palette";
import { Toolbar } from "@/game/Toolbar";
import { clearDraft, usePuzzle } from "@/game/usePuzzle";
import { cn } from "@/lib/utils";

interface Props {
  me: RunMe | null;
  reload(): Promise<void>;
  go(path: string): void;
}

/**
 * `/play` is whatever puzzle the run currently holds — there is no key in the
 * URL because there is nothing to choose. The server issues one rung at a time
 * and derives the next from the grid it accepted for the last, so a client that
 * could name a puzzle would be naming one it has no way to reach.
 *
 * Four states, in the order a run passes through them: no run, a run waiting on
 * a human, a run with nothing open, and a board.
 */
export function Play({ me, reload, go }: Props) {
  if (!me) {
    return (
      <div className="grid min-h-[50vh] place-items-center">
        <Loader2 className="size-4 animate-spin text-muted" />
      </div>
    );
  }
  if (!me.run) return <StartRun reload={reload} />;
  if (me.run.status === "pending") return <WaitingForAHuman me={me} reload={reload} go={go} />;
  if (me.run.status !== "open") {
    return (
      <Frame>
        <h1 className="t-title">This run is {me.run.status}.</h1>
        <p className="mt-2 text-muted">
          Nothing more can be banked against it. Register another to keep going.
        </p>
      </Frame>
    );
  }
  return <Open run={me.run} open={me.open} reload={reload} />;
}

/** The single-column shell every pre-board state uses. No card: a narrow
 *  measure and space do the framing, which is what both references do. */
function Frame({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-lg px-5 pt-10 pb-20">{children}</div>;
}

/* ------------------------------------------------------------------ */
/* Getting a run                                                       */
/* ------------------------------------------------------------------ */

const PAIRING_STASH = "pixe:pairing";

/**
 * An agent registers itself over the API and never sees this form. It is here
 * for the person who opened the page to find out what pixe is, and for the one
 * driving a browser by hand.
 */
function StartRun({ reload }: { reload(): Promise<void> }) {
  const [operatorKey, setOperatorKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const reg = await api.register(operatorKey.trim() || undefined);
      // The pairing code is handed out once, with the registration. Keeping it
      // here means a reload does not strand a run whose human is still typing.
      if (reg.pairing) localStorage.setItem(PAIRING_STASH, JSON.stringify(reg.pairing));
      else localStorage.removeItem(PAIRING_STASH);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not register a run.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame>
      <h1 className="t-display">Start a run</h1>
      <p className="mt-3 text-muted">
        A run is issued one 64×64 board at a time, and the next one is derived from the grid the
        server accepted for the last. Nothing tells you the laws. You paint, the board reacts.
      </p>
      <p className="mt-2 t-small text-muted">
        An agent does this over the API instead: <code>POST /api/run</code>, then{" "}
        <code>/agents.txt</code> is the whole spec.
      </p>

      {/* One field, because a run declares nothing about itself: the "Agent"
          and "Model" boxes are gone along with the fields behind them. The
          label stays exactly "Operator key" and the button stays "Register" —
          the reference solver drives this form by those two strings. */}
      <form onSubmit={start} className="mt-7 flex flex-col gap-4">
        <label className="block">
          <span className="t-micro text-muted">Operator key</span>
          <span className="mt-0.5 mb-1 block t-small text-muted">
            Optional. If a human has vouched for you before, this skips the pairing step entirely.
          </span>
          <Input
            value={operatorKey}
            onChange={(e) => setOperatorKey(e.target.value)}
            placeholder="pxop_…"
            spellCheck={false}
          />
        </label>

        {error && <p className="t-small text-bad">{error}</p>}

        <Button type="submit" className="mt-1 w-full" disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : "Register"}
        </Button>
        <p className="t-small text-muted">
          Without a key you are handed a code to read to a human, who says which harness is driving
          you. That answer is the only identity the benchmark publishes — pixe does not record
          which model ran, and cannot produce a model ranking. It ranks on wall clock and on how
          many times a run had to look at the board, neither of which can be talked down.
        </p>
      </form>
    </Frame>
  );
}

/** A registered run holds a real token and can do exactly two things with it:
 *  read its own state, and wait. */
function WaitingForAHuman({
  me,
  reload,
  go,
}: {
  me: RunMe;
  reload(): Promise<void>;
  go(path: string): void;
}) {
  const stashed = useMemo(() => readStash(), []);
  const pairing = me.pairing ?? stashed;
  const code = pairing?.userCode ?? stashed?.userCode ?? null;
  const interval = pairing?.pollIntervalMs ?? 3000;

  useEffect(() => {
    const t = setInterval(() => void reload(), interval);
    return () => clearInterval(t);
  }, [reload, interval]);

  const link = code ? `/for-humans?code=${code}` : "/for-humans";

  return (
    /* The heading stays "Ask your human" and the code stays an ABCD-EFGH
       string on its own line: the solver reads this screen to know it is
       blocked on pairing, and reads the code out to its operator. */
    <Frame>
      <h1 className="t-display">Ask your human</h1>
      <p className="mt-3 text-muted">
        {pairing?.message ??
          "A person has to vouch for this run once before the server will issue it a board."}{" "}
        They are asked which harness is driving — the one claim on the table that only they know.
      </p>

      {code ? (
        <div className="mt-7 rule-t rule-b py-7 text-center">
          <p className="t-micro text-muted">Your code</p>
          <p className="mt-2 t-num text-[32px] leading-none tracking-[0.14em]">{code}</p>
        </div>
      ) : (
        <p className="mt-7 rule-t rule-b py-5 t-small text-muted">
          The code was handed out with the registration and is not repeated by the API. If you have
          lost it, register again for a fresh one.
        </p>
      )}

      <p className="mt-5 t-small text-muted">
        Send them to <span className="text-ink">/for-humans</span> with it. Twenty seconds, once per
        person — they walk away with a key that pairs every run they start after this one.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={() => go(link)}>Open the pairing page</Button>
        <Button variant="outline" onClick={() => void reload()}>
          Check again
        </Button>
      </div>

      {pairing?.expired && (
        <p className="mt-3 t-small text-bad">
          That code has expired. Register again for a fresh one.
        </p>
      )}
    </Frame>
  );
}

function readStash(): Pairing | null {
  try {
    const raw = localStorage.getItem(PAIRING_STASH);
    return raw ? (JSON.parse(raw) as Pairing) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* The open rung                                                       */
/* ------------------------------------------------------------------ */

function Open({
  run,
  open,
  reload,
}: {
  run: RunSummary;
  open: RunMe["open"];
  reload(): Promise<void>;
}) {
  const [issue, setIssue] = useState<Issue | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A vouched-for run has no use for its old code, and a stale one on screen
  // would send the next human to a page that will refuse it.
  useEffect(() => localStorage.removeItem(PAIRING_STASH), []);

  // Re-reading the board after a reload is a legitimate recovery path: it hands
  // back a fresh receipt, which only rewinds this client's own attested tally.
  useEffect(() => {
    if (!open) return;
    let live = true;
    api
      .board()
      .then((b) => live && setIssue(b))
      .catch((err: unknown) => live && setError(err instanceof ApiError ? err.message : "No board."));
    return () => {
      live = false;
    };
  }, [open?.idx, open?.key]);

  const next = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setIssue(await api.next());
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not take the next puzzle.");
    } finally {
      setBusy(false);
    }
  }, [reload]);

  if (!issue) {
    return (
      <Frame>
        <h1 className="t-display">{open ? "Fetching your board…" : "Nothing open"}</h1>
        <p className="mt-3 text-muted">
          {open
            ? "You already hold rung " + open.idx + "."
            : "Take the next rung of the chain. Its key comes out of the last grid the server accepted from you, so there is no way to look ahead."}
        </p>
        {error && <p className="mt-3 t-small text-bad">{error}</p>}
        {/* "Take the next puzzle" is a documented seam — the solver clicks it
            by name. */}
        {(!open || error) && (
          <Button className="mt-5" onClick={() => void next()} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : "Take the next puzzle"}
          </Button>
        )}
      </Frame>
    );
  }

  return (
    <Studio key={issue.idx} run={run} issue={issue} onNext={next} nexting={busy} nextError={error} />
  );
}

/* ------------------------------------------------------------------ */
/* The board                                                           */
/* ------------------------------------------------------------------ */

function Studio({
  run,
  issue,
  onNext,
  nexting,
  nextError,
}: {
  run: RunSummary;
  issue: Issue;
  onNext(): Promise<void>;
  nexting: boolean;
  /** Usually the sixty-second hold before a board may be abandoned. */
  nextError: string | null;
}) {
  const state = usePuzzle(run.runId, issue);
  const { board, emit } = state;

  const [tool, setTool] = useState<Tool>("brush");
  const [brush, setBrush] = useState(4);
  const [mirror, setMirror] = useState<Mirror>("none");
  const [hue, setHue] = useState(0);
  const [showGrid, setShowGrid] = useState(false);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [notes, setNotes] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [banked, setBanked] = useState<Banked | null>(null);

  const last = useRef<{ x: number; y: number } | null>(null);
  const rectStart = useRef<{ x: number; y: number } | null>(null);
  /** Where a stroke started, in wall clock and in cells written. */
  const strokeFrom = useRef<{ at: number; version: number } | null>(null);

  /* --- field notes: the player's own record, since the game keeps quiet --- */

  const notesKey = `pixe:notes:${run.runId}:${issue.idx}`;
  useEffect(() => setNotes(localStorage.getItem(notesKey) ?? ""), [notesKey]);
  useEffect(() => {
    const t = setTimeout(() => localStorage.setItem(notesKey, notes), 400);
    return () => clearTimeout(t);
  }, [notes, notesKey]);

  /* --- painting ---------------------------------------------------- */

  const activeHue = tool === "eraser" ? EMPTY : hue;

  const pickHue = useCallback(
    (h: number) => {
      setHue(h);
      setTool((t) => (t === "eraser" || t === "picker" ? "brush" : t));
      emit("pick");
    },
    [emit],
  );

  const chooseTool = useCallback(
    (t: Tool) => {
      setTool(t);
      emit("pick");
    },
    [emit],
  );

  const sizeBrush = useCallback(
    (n: number) => {
      setBrush(n);
      emit("pick");
    },
    [emit],
  );

  const handlers = useMemo(
    () => ({
      onDown(x: number, y: number, alt: boolean) {
        if (alt || tool === "picker") {
          const v = board.grid[y * GRID + x]!;
          if (v >= 0) pickHue(v);
          if (tool !== "picker") return;
          return;
        }
        strokeFrom.current = { at: Date.now(), version: board.version };
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
        const from = strokeFrom.current;
        strokeFrom.current = null;
        if (!board.commit()) return;
        state.touch();
        // `Board.version` counts cells actually written, so the difference over
        // a gesture is exactly how many cells it touched — no second tally to
        // keep and none to get wrong.
        emit(tool === "bucket" ? "paint" : "stroke", {
          n: from ? board.version - from.version : 1,
          d: from ? Date.now() - from.at : 0,
        });
      },
      onHover(x: number, y: number) {
        setHover({ x, y });
      },
      onLeave() {
        setHover(null);
      },
    }),
    [board, tool, brush, mirror, activeHue, state, emit, pickHue],
  );

  const mutate = useCallback(
    (fn: (b: Board) => void) => {
      const before = board.version;
      board.begin();
      fn(board);
      if (!board.commit()) return;
      state.touch();
      emit("paint", { n: board.version - before });
    },
    [board, state, emit],
  );

  const undo = useCallback(() => {
    if (!board.undo()) return;
    state.touch();
    emit("undo");
  }, [board, state, emit]);

  const redo = useCallback(() => {
    if (!board.redo()) return;
    state.touch();
    emit("undo");
  }, [board, state, emit]);

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
        pickHue(n - 1);
        return;
      }
      switch (e.key.toLowerCase()) {
        case "b": chooseTool("brush"); break;
        case "g": chooseTool("bucket"); break;
        case "r": chooseTool("rect"); break;
        case "e": chooseTool("eraser"); break;
        case "i": chooseTool("picker"); break;
        case "m": setMirror((m) => (m === "none" ? "x" : m === "x" ? "y" : m === "y" ? "quad" : "none")); break;
        case "[": sizeBrush(brush <= 2 ? 1 : brush / 2); break;
        case "]": sizeBrush(Math.min(16, brush === 1 ? 2 : brush * 2)); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, pickHue, chooseTool, sizeBrush, brush]);

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
    setSubmitting(true);
    setRefused(null);
    try {
      const out = await state.submit();
      if (out.accepted) {
        clearDraft(run.runId, issue);
        setBanked(out);
      } else {
        setRefused(out.message);
      }
    } catch (err) {
      setRefused(err instanceof ApiError ? err.message : "Could not submit. Try again?");
    } finally {
      setSubmitting(false);
    }
  };

  const pct = Math.round((state.filled / CELLS) * 100);
  const bad = state.badCells.size;
  const ready = state.solved;

  return (
    <div className="mx-auto w-full max-w-6xl px-5 pb-14">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <h1 className="t-lead truncate">{issue.title}</h1>
          {/* The solver watches the attested-events count here to know the page
              is still talking to the server. Keep the shape of this line. */}
          <p className="t-num text-[11px] text-muted">
            Rung {issue.idx} · {issue.key} · {state.events} attested events
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {state.settling && <Badge title="Waiting on the board's opinion">thinking…</Badge>}
          <Badge variant="solid">{issue.points} pts</Badge>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
        {/* ---------------- canvas ---------------- */}
        <div className="min-w-0">
          <div className="mx-auto w-full max-w-[min(78vh,52rem)]">
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

            {/* The readout under the board. Every figure is mono, and the two
                that report trouble are the only coloured text on the screen. */}
            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 t-num text-[11px] text-muted">
              <span>{hover ? `x ${hover.x}, y ${hover.y}` : `${GRID}×${GRID}`}</span>
              <span>
                <span className="text-ink">{state.filled}</span> / {CELLS} filled
              </span>
              {bad > 0 && (
                <span className="text-bad">
                  {bad} cell{bad === 1 ? "" : "s"} unhappy
                </span>
              )}
              {state.hotHues.size > 0 && (
                <span className="text-bad">
                  {[...state.hotHues].map(hueName).join(", ")} restless
                </span>
              )}
              {state.bonds > 0 && <span className="ml-auto">bonds {state.bonds}</span>}
            </div>
          </div>
        </div>

        {/* ---------------- side panel ---------------- */}
        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:self-start">
          <Palette hue={hue} onPick={pickHue} counts={counts} hot={state.hotHues} />

          <Toolbar
            tool={tool}
            setTool={chooseTool}
            brush={brush}
            setBrush={sizeBrush}
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
              className="t-micro mb-1.5 flex w-full items-center gap-1 text-muted hover:text-ink"
            >
              <NotebookPen className="size-3" strokeWidth={1.75} />
              Field notes
              <span className="ml-auto">{notesOpen ? "hide" : "show"}</span>
            </button>
            {notesOpen && (
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                spellCheck={false}
                placeholder={"what have you worked out?\n\ne.g. banana hates grape\nleft side won't take mint"}
                className="h-36 w-full resize-y rounded-[5px] rule-all bg-raise p-2.5 text-[12px] leading-relaxed placeholder:text-muted/70 focus:border-ink focus:outline-none"
              />
            )}
          </div>

          <div className="rule-t pt-3">
            {/* Fill progress. A 2px hairline bar rather than a fat capsule —
                it is a status reading, not a trophy. */}
            <div className="mb-2.5 h-0.5 w-full bg-rule">
              <div
                className={cn("h-full transition-[width] duration-300", ready ? "bg-good" : "bg-ink")}
                style={{ width: `${pct}%` }}
              />
            </div>
            {/* Never disabled. Submitting is how you answer *and* how you
                observe — a grid that is not a solution comes back with the
                complaints attached, and those complaints are the only teacher
                here. It is priced instead: every one is on the record. */}
            {/* The label IS the verdict, and the solver reads it: "Bank it for
                N pts" is the board saying the grid is done. Do not reword
                either branch, and do not add a disabled state for "not yet
                solvable" — submitting is how you observe. */}
            <Button
              variant={ready ? "good" : "solid"}
              className="w-full"
              disabled={submitting}
              onClick={submit}
            >
              {submitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : ready ? (
                <>
                  <PartyPopper className="size-3.5" strokeWidth={1.75} /> Bank it for {issue.points}{" "}
                  pts
                </>
              ) : (
                "Submit and see what breaks"
              )}
            </Button>
            {refused && <p className="mt-2 t-small text-bad">{refused}</p>}
            {state.error && <p className="mt-2 t-small text-bad">{state.error}</p>}
            <p className="mt-2 t-small text-muted">
              Silence on a full grid means solved. On a partial one it only means nothing is
              definitely wrong yet.
            </p>
          </div>

          <div>
            {/* "Abandon this board" is a documented seam. */}
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => void onNext()}
              disabled={nexting}
            >
              {nexting ? <Loader2 className="size-3.5 animate-spin" /> : "Abandon this board"}
            </Button>
            {nextError && <p className="mt-1 text-center t-small text-bad">{nextError}</p>}
          </div>
        </div>
      </div>

      {banked && (
        <Solved
          banked={banked}
          onClose={() => setBanked(null)}
          onNext={() => {
            setBanked(null);
            void onNext();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The reveal                                                          */
/* ------------------------------------------------------------------ */

/**
 * The only place rule text ever appears, and it appears exactly once the board
 * is banked. Safe now and only now: this rung is closed, and the next key is
 * unreachable without the run secret no matter what the agent learns about
 * this one.
 */
function Solved({
  banked,
  onClose,
  onNext,
}: {
  banked: Banked;
  onClose(): void;
  onNext(): void;
}) {
  const [copied, setCopied] = useState(false);
  const shareUrl = `${location.origin}/a/${banked.shareId}`;
  const reveal = banked.reveal;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt("Copy your link:", shareUrl);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <Confetti />
        <DialogHeader>
          <div className="flex items-center gap-1.5">
            <Sparkles className="size-3.5 text-muted" strokeWidth={1.75} />
            <DialogTitle>{banked.alreadySolved ? "Already in the books" : "Solved"}</DialogTitle>
          </div>
          <DialogDescription>
            {banked.alreadySolved
              ? "This rung was already banked, so it pays nothing twice."
              : `${(banked.wallMs / 1000).toFixed(1)}s from issue to accepted, over ${banked.apiCalls} requests and ${banked.events} attested events.`}
          </DialogDescription>
        </DialogHeader>

        <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto p-5">
          <div className="mb-4 flex flex-wrap gap-1.5">
            <Badge variant="solid">+{banked.points} pts</Badge>
            <Badge variant={banked.bonds >= banked.parBonds ? "good" : "default"}>
              {banked.bonds} bonds · par {banked.parBonds}
            </Badge>
            <Badge>{banked.key}</Badge>
          </div>

          <Button size="sm" variant="outline" onClick={copy}>
            <Copy className="size-3.5" strokeWidth={1.75} />
            {copied ? "Copied" : "Copy the share link"}
          </Button>

          {reveal && (
            <>
              <h3 className="t-lead mt-7">What you were actually up against</h3>
              <p className="mt-0.5 mb-3 t-small text-muted">
                {reveal.rules.length} hidden laws, in this run's own dialect. You never got told any
                of them.
              </p>
              {/* One law per line, separated by hairlines. They are a list of
                  statements, not a set of cards. */}
              <ul className="rule-t">
                {reveal.rules.map((r, i) => (
                  <li key={i} className="rule-b py-2 text-[12px] leading-snug">
                    {ruleText(r, reveal.scheme)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="flex gap-2 rule-t p-4">
          <Button variant="outline" className="flex-1" onClick={onClose}>
            Keep looking at it
          </Button>
          <Button className="flex-1" onClick={onNext}>
            Next rung →
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
