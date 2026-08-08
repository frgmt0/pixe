import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decodeGrid, encodeGrid } from "@shared/codec";
import { CELLS, GRID } from "@shared/palette";
import { gridRows } from "@shared/protocol";
import { api, type Feedback, type Issue, type SubmitOutcome } from "@/lib/api";
import { Board } from "./board";

export interface PuzzleState {
  board: Board;
  version: number;
  badCells: Set<number>;
  hotHues: Set<number>;
  filled: number;
  bonds: number;
  solved: boolean;
  /** Probes the server has charged this rung. Every one was a look at the board. */
  probes: number;
  /** The board is holding an opinion older than the pixels on it. */
  settling: boolean;
  error: string | null;
  /** Nudge after any board mutation: schedules the local draft save. */
  touch(): void;
  /** Ask the board what is wrong with the current grid. Costs a probe. */
  probe(): void;
  submit(): Promise<SubmitOutcome>;
}

/**
 * Long enough that a burst of painting is one probe rather than thirty.
 *
 * This is the honest shape of the new API: there is no free feedback channel,
 * so every look at the board is a submit and every submit is counted. The page
 * pays the same price a runner script does, which is the point — nothing a
 * browser can do here is cheaper than what an HTTP client can do.
 */
const PROBE_DEBOUNCE_MS = 1200;
const DRAFT_DEBOUNCE_MS = 1200;

interface Verdict extends Feedback {
  /** The grid this verdict was passed on, so repainted cells can stop flashing. */
  grid: Int8Array | null;
}

const NO_VERDICT: Verdict = {
  badCells: new Set(),
  hotHues: new Set(),
  filled: 0,
  empty: CELLS,
  bonds: 0,
  solved: false,
  grid: null,
};

/**
 * Owns one rung's board and the feedback that comes back for it.
 *
 * The client does not know the laws, so nothing here evaluates anything. The
 * loop is: paint, debounce, submit the grid, paint the answer. Both feedback
 * channels keep their exact shapes — `Set<number>` in, red flash and swatch
 * buzz out — only their source moved from a local `assess()` to the last thing
 * the server said.
 *
 * Mount it keyed by `issue.idx` and the draft and the verdict start clean.
 */
export function usePuzzle(runId: string, issue: Issue): PuzzleState {
  const board = useMemo(() => new Board(), []);
  const draftKey = `pixe:draft:${runId}:${issue.idx}:${issue.key}`;

  const [version, setVersion] = useState(0);
  const [verdict, setVerdict] = useState<Verdict>(NO_VERDICT);
  const [probes, setProbes] = useState(0);
  const [settling, setSettling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const probeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pump = useRef<Promise<void>>(Promise.resolve());
  /** Board version the server has been shown, so a pause costs no probe. */
  const shown = useRef(-1);
  const lastSaved = useRef("");

  /* --- the draft -------------------------------------------------- */

  useEffect(() => {
    board.load(decodeGrid(localStorage.getItem(draftKey)) ?? emptyGrid());
    // Locked cells are given, not deduced: a later phase hands back some of the
    // agent's own pixels and refuses any grid that changes them. Stamping them
    // over the draft is the honest starting position.
    for (const c of issue.locked) board.grid[c.y * GRID + c.x] = c.hue;
    lastSaved.current = encodeGrid(board.grid);
    setVersion(board.version);
  }, [board, draftKey, issue.locked]);

  const saveDraft = useCallback(() => {
    const art = encodeGrid(board.grid);
    if (art === lastSaved.current) return;
    lastSaved.current = art;
    localStorage.setItem(draftKey, art);
  }, [board, draftKey]);

  const touch = useCallback(() => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(saveDraft, DRAFT_DEBOUNCE_MS);
  }, [saveDraft]);

  /* --- looking at the board ---------------------------------------- */

  const send = useCallback(async () => {
    const at = board.version;
    if (at === shown.current) return;
    const grid = Int8Array.from(board.grid);
    try {
      const out = await api.submit(runId, gridRows(grid));
      shown.current = at;
      setError(null);
      if (out.accepted) {
        // A phase handoff is not a solve: the rung is still open and the next
        // board arrives in the same response. The UI agent picks that up.
        setVerdict({ ...NO_VERDICT, filled: CELLS, solved: out.rungComplete, grid });
      } else {
        setProbes(out.probes);
        setVerdict({ ...out.feedback, grid });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "The board stopped answering.");
    }
  }, [board, runId]);

  /** One request at a time: two probes in flight would only race each other. */
  const drain = useCallback(() => {
    pump.current = pump.current.then(async () => {
      await send();
      setSettling(false);
    });
    return pump.current;
  }, [send]);

  const probe = useCallback(() => {
    setSettling(true);
    if (probeTimer.current) clearTimeout(probeTimer.current);
    probeTimer.current = setTimeout(() => void drain(), PROBE_DEBOUNCE_MS);
  }, [drain]);

  /* --- the loop that only animates now ----------------------------- */

  useEffect(() => {
    let raf = 0;
    let seen = -1;
    const tick = () => {
      if (board.version !== seen) {
        seen = board.version;
        setVersion(board.version);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [board]);

  // Never lose a canvas to a closed tab.
  useEffect(() => {
    const flush = () => saveDraft();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (probeTimer.current) clearTimeout(probeTimer.current);
      flush();
    };
  }, [saveDraft]);

  /* --- what the canvas draws --------------------------------------- */

  /**
   * Between round trips the last verdict stands, minus anything the player has
   * since repainted: a cell that has changed colour has not been judged in that
   * colour, so it stops flashing rather than accusing the wrong pixel.
   *
   * `version` is a dependency because `board.grid` is mutated in place — the
   * version counter is the only signal that it moved.
   */
  const badCells = useMemo(() => {
    const snap = verdict.grid;
    if (!snap || verdict.badCells.size === 0) return verdict.badCells;
    const live = new Set<number>();
    for (const i of verdict.badCells) if (board.grid[i] === snap[i]) live.add(i);
    return live;
  }, [verdict, board, version]);

  const filled = useMemo(() => board.countFilled(), [board, version]);

  const submit = useCallback(async () => {
    if (probeTimer.current) {
      clearTimeout(probeTimer.current);
      probeTimer.current = null;
    }
    const at = board.version;
    const grid = Int8Array.from(board.grid);
    const out = await api.submit(runId, gridRows(grid));
    shown.current = at;
    if (!out.accepted) {
      setProbes(out.probes);
      setVerdict({ ...out.feedback, grid });
    }
    return out;
  }, [board, runId]);

  return {
    board,
    version,
    badCells,
    hotHues: verdict.hotHues,
    filled,
    bonds: verdict.bonds,
    solved: verdict.solved && shown.current === version,
    probes,
    settling,
    error,
    touch,
    probe,
    submit,
  };
}

function emptyGrid(): Int8Array {
  const g = new Int8Array(CELLS);
  g.fill(-1);
  return g;
}

export function clearDraft(runId: string, issue: Issue): void {
  localStorage.removeItem(`pixe:draft:${runId}:${issue.idx}:${issue.key}`);
}
