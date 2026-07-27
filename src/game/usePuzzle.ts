import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decodeGrid, encodeGrid } from "@shared/codec";
import { generatePuzzle, type Puzzle } from "@shared/generate";
import { CELLS } from "@shared/palette";
import { assess, type Assessment } from "@shared/validate";
import { api } from "@/lib/api";
import { Board } from "./board";

export interface PuzzleState {
  board: Board;
  puzzle: Puzzle;
  version: number;
  badCells: Set<number>;
  hotHues: Set<number>;
  filled: number;
  bonds: number;
  solved: boolean;
  loading: boolean;
  /** Nudge after any board mutation to re-run assessment and schedule a save. */
  touch(): void;
}

const SAVE_DEBOUNCE_MS = 1200;

/**
 * Owns one puzzle's board, its live assessment, and autosave.
 *
 * Assessment runs on a rAF tick rather than per pointer event: a full 8-rule
 * pass over 4096 cells is ~0.2ms, cheap once a frame and wasteful thirty
 * times a frame during a fast drag.
 */
export function usePuzzle(key: string, signedIn: boolean): PuzzleState {
  const puzzle = useMemo(() => generatePuzzle(key), [key]);
  const board = useMemo(() => new Board(), [key]);

  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<Assessment>(() => assess(key, board.grid));

  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef<string>("");

  /* --- load saved work ------------------------------------------- */

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    board.load(decodeGrid(localStorage.getItem(cacheKey(key))) ?? emptyFor());

    const hydrate = async () => {
      if (signedIn) {
        try {
          const { art } = await api.progress(key);
          const grid = decodeGrid(art);
          // Only take the server copy if we have nothing locally — a local
          // draft is always more recent than whatever was last synced.
          if (grid && !cancelled && !localStorage.getItem(cacheKey(key))) board.load(grid);
        } catch {
          /* offline or signed out mid-flight; the local draft stands */
        }
      }
      if (cancelled) return;
      lastSaved.current = encodeGrid(board.grid);
      setVersion((v) => v + 1);
      setResult(assess(key, board.grid));
      setLoading(false);
    };
    void hydrate();

    return () => {
      cancelled = true;
    };
  }, [key, board, signedIn]);

  /* --- live assessment ------------------------------------------- */

  useEffect(() => {
    let raf = 0;
    let lastVersion = -1;
    const tick = () => {
      if (board.version !== lastVersion) {
        lastVersion = board.version;
        setResult(assess(key, board.grid));
        setVersion(board.version);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [board, key]);

  /* --- autosave --------------------------------------------------- */

  const flush = useCallback(() => {
    const art = encodeGrid(board.grid);
    if (art === lastSaved.current) return;
    lastSaved.current = art;
    localStorage.setItem(cacheKey(key), art);
    if (signedIn) void api.saveProgress(key, art).catch(() => undefined);
  }, [board, key, signedIn]);

  const touch = useCallback(() => {
    dirty.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
  }, [flush]);

  // Never lose a canvas to a closed tab.
  useEffect(() => {
    const onHide = () => {
      if (dirty.current) flush();
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onHide);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      onHide();
    };
  }, [flush]);

  return {
    board,
    puzzle,
    version,
    badCells: result.badCells,
    hotHues: result.hotHues,
    filled: result.filled,
    bonds: result.bonds,
    solved: result.solved,
    loading,
    touch,
  };
}

const cacheKey = (key: string) => `pixe:draft:${key}`;

function emptyFor() {
  const g = new Int8Array(CELLS);
  g.fill(-1);
  return g;
}

export function clearDraft(key: string): void {
  localStorage.removeItem(cacheKey(key));
}
