import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decodeGrid, encodeGrid } from "@shared/codec";
import { CELLS } from "@shared/palette";
import {
  api,
  MAX_BATCH,
  type AttestedEvent,
  type EventKind,
  type Feedback,
  type Issue,
  type SubmitOutcome,
} from "@/lib/api";
import { Board } from "./board";
import { proveExec } from "./execProof";

export interface PuzzleState {
  board: Board;
  version: number;
  badCells: Set<number>;
  hotHues: Set<number>;
  filled: number;
  bonds: number;
  solved: boolean;
  /** Attested events the server has counted for this rung. */
  events: number;
  /** The board is holding an opinion older than the pixels on it. */
  settling: boolean;
  error: string | null;
  /** Nudge after any board mutation: schedules the local draft save. */
  touch(): void;
  /** Record something that happened in the browser. See the table in WIRING-HARDEN §5. */
  emit(t: EventKind, extra?: { n?: number; d?: number }): void;
  /** Flush the queue and hand back the receipt that covers it. */
  settle(): Promise<string | null>;
  submit(): Promise<SubmitOutcome>;
}

/**
 * Long enough that a drag is one round trip rather than thirty, short enough
 * that the board still feels like it is reacting. This is not a nicety — the
 * feedback used to be a 0.2ms local call and per-frame assessment is exactly
 * the thing that had to go, so the debounce is the design.
 */
const ATTEST_DEBOUNCE_MS = 250;
const DRAFT_DEBOUNCE_MS = 1200;
const MAX_STROKE_MS = 60_000;

/** Envelope version. Must match `ENVELOPE_VERSION` in `server/attest.ts`. */
const ENVELOPE_VERSION = 2;

/* ------------------------------------------------------------------ */
/* The write ledger                                                    */
/* ------------------------------------------------------------------ */

/**
 * Every attested event carries the exact cells it wrote, and the server replays
 * them onto the canvas its receipt is holding: the writes must produce, cell
 * for cell, the grid this client then asks for feedback on. So the envelope is
 * no longer a ceremony performed alongside the artwork — it has to contain the
 * artwork, as painting operations, in order.
 *
 * The grammar and its rationale live in `server/attest.ts` (`parseWrites`).
 * This is the encoder half and it is duplicated on purpose, the same way
 * `execProof.ts` duplicates its answer format: the bundle reaching into
 * `server/` is precisely the mistake that cost this project 1105 solves, and
 * three lines are not worth reopening it. Change one, change both.
 */
interface WriteRun {
  start: number;
  len: number;
  hue: number;
}

const LEDGER_CHARS = "abcdefghi";

function encodeWrites(runs: readonly WriteRun[]): string {
  let out = "";
  let end = 0;
  for (const r of runs) {
    const gap = r.start - end;
    out += LEDGER_CHARS[r.hue < 0 ? 8 : r.hue];
    if (gap > 0) out += gap.toString(36).toUpperCase();
    if (r.len > 1) out += `-${r.len.toString(36).toUpperCase()}`;
    end = r.start + r.len;
  }
  return out;
}

/**
 * The board is a plain mutable object and the tools write straight into it, so
 * rather than thread a diff out of every tool this hook keeps its own shadow
 * copy and reads the difference off it. One 4096-cell sweep per event, against
 * a page that already writes 4096 pixels per frame.
 *
 * Doing it here also means nothing can paint without being attested: `undo`,
 * `redo`, bucket fills, clear, fill-all and the swap-hue button all move the
 * grid, and all of them land in the next event's ledger whether or not the code
 * that triggered them knew about attestation.
 */
function diffRuns(from: Int8Array, to: Int8Array): WriteRun[] {
  const runs: WriteRun[] = [];
  let i = 0;
  while (i < CELLS) {
    if (from[i] === to[i]) {
      i++;
      continue;
    }
    const hue = to[i]!;
    let j = i + 1;
    while (j < CELLS && to[j] === hue && from[j] !== to[j]) j++;
    runs.push({ start: i, len: j - i, hue });
    i = j;
  }
  return runs;
}

function applyRuns(grid: Int8Array, runs: readonly WriteRun[]): void {
  for (const r of runs) grid.fill(r.hue, r.start, r.start + r.len);
}

/** One queued event and the writes that happened just before it. */
interface Queued {
  ev: AttestedEvent & { w?: string };
  runs: WriteRun[];
  /** `board.version` when this was emitted, so a verdict knows what it judged. */
  ver: number;
}

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
 * Owns one rung's board, the attested event queue, and the feedback that comes
 * back for it.
 *
 * The client no longer knows the laws, so nothing here evaluates anything. The
 * loop is: paint, queue an event, debounce, `POST /api/attest` with the canvas
 * attached, and paint the answer. Both feedback channels keep their exact
 * shapes — `Set<number>` in, red flash and swatch buzz out — only their source
 * moved from a local `assess()` to the last thing the server said.
 *
 * The hook holds one rung. Mount it keyed by `issue.idx` and the receipt chain,
 * the draft and the event stream all start clean with the board.
 */
export function usePuzzle(runId: string, issue: Issue): PuzzleState {
  const board = useMemo(() => new Board(), []);
  const draftKey = `pixe:draft:${runId}:${issue.idx}:${issue.key}`;

  const [version, setVersion] = useState(0);
  const [verdict, setVerdict] = useState<Verdict>(NO_VERDICT);
  const [events, setEvents] = useState(0);
  const [settling, setSettling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Advanced by every `/api/attest`; the run's whole tally hangs off it. The
   * exec pair rides along untouched — a challenge to answer and the signed
   * count of how many have been answered so far.
   */
  const chain = useRef({
    receipt: issue.receipt,
    nonce: issue.nonce,
    exec: issue.exec,
    execReceipt: issue.execReceipt,
  });
  const queue = useRef<Queued[]>([]);
  /**
   * Two shadows of the grid, both starting where the server's receipt starts —
   * blank. `emitted` is what the last queued event left behind, and is what new
   * writes are measured against. `sent` is what the last *acknowledged* batch
   * left behind, and is therefore an exact copy of the canvas inside the
   * server's receipt.
   *
   * They are separate because a batch can be refused. Advancing `sent` only on
   * a 200 is what lets a failed envelope be retried instead of desynchronising
   * the ledger for the rest of the puzzle.
   *
   * A restored draft needs no special case: `emitted` starts blank, so the
   * first event after a reload carries the whole draft as its writes. That is
   * the honest account — those cells really were unattested until now, because
   * `/api/board` hands out a fresh receipt over a blank canvas.
   */
  const emitted = useRef<Int8Array>(emptyGrid());
  const sent = useRef<Int8Array>(emptyGrid());
  const lastAt = useRef(0);
  const attestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pump = useRef<Promise<void>>(Promise.resolve());
  /** Board version the server has been shown, so a pause costs no assessment. */
  const shown = useRef(-1);
  const lastSaved = useRef("");

  /* --- the draft -------------------------------------------------- */

  useEffect(() => {
    board.load(decodeGrid(localStorage.getItem(draftKey)) ?? emptyGrid());
    lastSaved.current = encodeGrid(board.grid);
    setVersion(board.version);
  }, [board, draftKey]);

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

  /* --- the event stream -------------------------------------------- */

  /**
   * Timestamps must be non-decreasing across batches, not merely within one:
   * the server compares the first event of a batch against the last `at` it has
   * already attested. Two events inside the same millisecond get a flat `+1`,
   * which is the whole of the requirement — the server has no opinion about the
   * *shape* of the timing and must not acquire one, since the players it is for
   * drive the page from a script.
   */
  const stamp = useCallback(() => {
    const now = Date.now();
    const at = now > lastAt.current ? now : lastAt.current + 1;
    lastAt.current = at;
    return at;
  }, []);

  /** `false` when the envelope was refused and the batch is still queued. */
  const sendBatch = useCallback(async (): Promise<boolean> => {
    const batch = queue.current.slice(0, MAX_BATCH);
    if (batch.length === 0) return true;

    // Prove first, snapshot second. `proveExec` reads the pixels back off the
    // live canvas and waits a couple of frames doing it, so a stroke can land
    // between the readback and the grid below — which costs one uncounted proof
    // out of the dozens a board produces, and never a rejected anything.
    const proof = await proveExec(chain.current.exec);

    // Replay this batch the way the server will, so the canvas we ask about is
    // the canvas our own ledger paints — never `board.grid`, which may already
    // be a stroke ahead of the last event we queued.
    const next = Int8Array.from(sent.current);
    let painted = false;
    for (const q of batch) {
      if (q.runs.length === 0) continue;
      applyRuns(next, q.runs);
      painted = true;
    }
    const at = batch[batch.length - 1]!.ver;

    // Assembled as a value rather than inline because `v` and each event's `w`
    // are not in `@/lib/api`'s `AttestBody` yet — that file was out of scope for
    // this change. Widening those two types there is the tidy follow-up; the
    // wire format is what it is either way.
    const body = {
      v: ENVELOPE_VERSION,
      idx: issue.idx,
      receipt: chain.current.receipt,
      nonce: chain.current.nonce,
      events: batch.map((q) => q.ev),
      ...(painted ? { art: encodeGrid(next) } : {}),
      execReceipt: chain.current.execReceipt,
      ...(proof ? { exec: proof } : {}),
    };

    try {
      const ack = await api.attest(body);
      queue.current.splice(0, batch.length);
      sent.current = next;
      chain.current = {
        receipt: ack.receipt,
        nonce: ack.nonce,
        exec: ack.exec,
        execReceipt: ack.execReceipt,
      };
      setEvents(ack.events);
      setError(null);
      if (ack.feedback) {
        shown.current = at;
        setVerdict({ ...ack.feedback, grid: next });
      }
      return true;
    } catch (err) {
      // The batch stays queued. Under the ledger a dropped envelope is not a
      // few lost events any more — it is a permanent disagreement about what
      // the canvas is made of, and every later batch would be refused for it.
      // The receipt did not advance, so re-presenting the same events against
      // the same receipt and nonce is exactly what the server expects next.
      setError(err instanceof Error ? err.message : "The board stopped answering.");
      return false;
    }
  }, [issue.idx]);

  /** One envelope at a time: the receipt chain has no way to merge two. */
  const drain = useCallback(() => {
    pump.current = pump.current.then(async () => {
      while (queue.current.length) {
        if (!(await sendBatch())) break;
      }
      setSettling(false);
    });
    return pump.current;
  }, [sendBatch]);

  const schedule = useCallback(() => {
    setSettling(true);
    if (attestTimer.current) clearTimeout(attestTimer.current);
    attestTimer.current = setTimeout(() => void drain(), ATTEST_DEBOUNCE_MS);
  }, [drain]);

  const emit = useCallback(
    (t: EventKind, extra?: { n?: number; d?: number }) => {
      // A stroke that painted nothing is not a stroke, and the server rejects
      // the whole envelope over one — so it is dropped here instead. Any writes
      // still outstanding stay outstanding and ride the next event.
      if ((t === "stroke" || t === "paint") && !extra?.n) return;

      const runs = diffRuns(emitted.current, board.grid);
      if (runs.length) applyRuns(emitted.current, runs);

      const ev: AttestedEvent & { w?: string } = { t, at: stamp() };
      if (extra?.n !== undefined) ev.n = Math.min(CELLS, Math.max(1, Math.round(extra.n)));
      if (extra?.d !== undefined) ev.d = Math.min(MAX_STROKE_MS, Math.max(0, Math.round(extra.d)));
      if (runs.length) ev.w = encodeWrites(runs);

      queue.current.push({ ev, runs, ver: board.version });
      schedule();
    },
    [board, schedule, stamp],
  );

  const settle = useCallback(async () => {
    if (attestTimer.current) {
      clearTimeout(attestTimer.current);
      attestTimer.current = null;
    }
    await drain();
    return chain.current.receipt || null;
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

  // Focus and visibility are attestable events in their own right, and the one
  // pair nothing in the UI would otherwise report.
  useEffect(() => {
    const onView = () => emit("view");
    document.addEventListener("visibilitychange", onView);
    window.addEventListener("focus", onView);
    return () => {
      document.removeEventListener("visibilitychange", onView);
      window.removeEventListener("focus", onView);
    };
  }, [emit]);

  // Never lose a canvas to a closed tab.
  useEffect(() => {
    const flush = () => saveDraft();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (attestTimer.current) clearTimeout(attestTimer.current);
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
    emit("intent");
    const receipt = await settle();
    const art = encodeGrid(board.grid);
    const grid = Int8Array.from(board.grid);
    const at = board.version;
    // The receipt goes up bare. It used to carry the canvas appended after a
    // `!`, because `/api/submit` handed attestation nothing but this string —
    // but that let the two diverge, since the grid the receipt named and the
    // `art` actually banked were never compared to each other. The route now
    // binds the receipt to the grid it decoded itself. The `intent` event above
    // is what carries the last few writes into the ledger, which is why it is
    // emitted before the flush rather than after.
    // Read after `settle()`, so it is the tally the flush just advanced rather
    // than the one this board started with.
    const out = await api.submit(art, receipt ?? "", chain.current.execReceipt);
    if (!out.accepted && out.feedback) {
      shown.current = at;
      setVerdict({ ...out.feedback, grid });
    }
    return out;
  }, [board, emit, settle]);

  return {
    board,
    version,
    badCells,
    hotHues: verdict.hotHues,
    filled,
    bonds: verdict.bonds,
    solved: verdict.solved && shown.current === version,
    events,
    settling,
    error,
    touch,
    emit,
    settle,
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
