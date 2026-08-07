/**
 * Every fetch the client makes, in one place, typed against `shared/protocol`.
 *
 * The rule that shapes this file: the client no longer knows the laws. It used
 * to re-derive each puzzle from its seed to drive the glow, which is exactly
 * what was extracted to batch-solve a thousand boards. So the two feedback
 * channels now arrive over the wire, and this module is where they are turned
 * back into the `Set<number>`s the canvas and the palette have always drawn.
 *
 * Nothing here imports the generator, the validator or the dialect. If it ever
 * does, the benchmark is over.
 */

import { decodeGrid } from "@shared/codec";
import type { MeterReport, RunStatus } from "@shared/protocol";
import type { Bond, Rule } from "@shared/rules";
import type { ZoneScheme } from "@shared/zones";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

interface Raw {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
}

/**
 * `credentials: "same-origin"` is the whole authentication story: the run token
 * lives in an HttpOnly `pixe_run` cookie, so the page never holds it and never
 * has to.
 */
async function raw(path: string, init?: RequestInit): Promise<Raw> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "same-origin",
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError("Can't reach the server. Is it awake?", 0);
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    if (text) data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ApiError("The server said something that wasn't JSON.", res.status);
  }
  return { ok: res.ok, status: res.status, data };
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await raw(path, init);
  if (!r.ok) {
    throw new ApiError(
      String(r.data.error ?? "Something went wrong."),
      r.status,
      typeof r.data.code === "string" ? r.data.code : undefined,
    );
  }
  return r.data as T;
}

const postJson = (body: unknown, headers?: Record<string, string>): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
  headers,
});

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

export interface RunSummary {
  runId: string;
  /**
   * The benchmarked identity, and null until a human has vouched for it. There
   * is no `model`: a harness driving subagents may be running several, so one
   * model string is ill-defined rather than merely unverifiable. `config` is
   * the operator's prose about the setup and is ranked by nothing.
   */
  harness: string | null;
  config: string | null;
  createdAt: number;
  status: RunStatus;
}

/** What an agent has to show a human before it is allowed to draw anything. */
export interface Pairing {
  userCode: string | null;
  verificationUri: string;
  verificationUriComplete: string | null;
  pollIntervalMs: number;
  expiresAt: number;
  expired: boolean;
  message: string | null;
}

export interface Registered {
  run: RunSummary;
  dialect: string;
  pairing: Pairing | null;
}

export interface RunMe {
  run: RunSummary | null;
  solved: number;
  points: number;
  bonds: number;
  open: { idx: number; key: string; issuedAt: number } | null;
  pairing: Pairing | null;
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" ? v : fallback);

const PAIRING_PAGE = "/for-humans";

function readPairing(d: Record<string, unknown>): Pairing | null {
  const nested = (d.pairing ?? null) as Record<string, unknown> | null;
  const src = nested ?? d;
  const code = typeof src.userCode === "string" ? src.userCode : null;
  if (!nested && !code) return null;
  return {
    userCode: code,
    verificationUri: str(src.verificationUri, PAIRING_PAGE),
    verificationUriComplete:
      typeof src.verificationUriComplete === "string" ? src.verificationUriComplete : null,
    pollIntervalMs: Math.max(1000, num(src.pollIntervalMs, 3000)),
    expiresAt: num(src.expiresAt),
    expired: src.expired === true,
    message: typeof src.message === "string" ? src.message : null,
  };
}

/**
 * A run is born `pending` and stays there until a human vouches for it, so an
 * absent status reads as `pending` rather than `open`. Guessing the other way
 * would have the page offering a board to a run the server will refuse.
 */
function readRun(d: Record<string, unknown> | null): RunSummary | null {
  if (!d) return null;
  const id = str(d.runId);
  if (!id) return null;
  return {
    runId: id,
    harness: typeof d.harness === "string" ? d.harness : null,
    config: typeof d.config === "string" ? d.config : null,
    createdAt: num(d.createdAt),
    status: str(d.status, "pending") as RunStatus,
  };
}

/* ------------------------------------------------------------------ */
/* The board and its feedback                                          */
/* ------------------------------------------------------------------ */

/** The open puzzle, plus the head of its attestation chain. */
export interface Issue {
  idx: number;
  key: string;
  title: string;
  points: number;
  issuedAt: number;
  /** Carried into the next `/api/attest`; every response hands back the pair. */
  receipt: string;
  nonce: string;
  /**
   * The execution-binding pair, opaque here exactly as the receipt and the
   * nonce are. `exec` is a challenge for `src/game/execProof.ts` to answer and
   * this module has no business reading it; `execReceipt` is the running tally,
   * signed by the server, that the answer is presented against.
   */
  exec: unknown;
  execReceipt: string;
  /** The rung a `POST /api/next` walked away from, when it closed one. */
  abandoned: number | null;
}

/**
 * The two channels, and nothing else: which cells are breaking a placement law
 * and which hues have an unhappy counting law. Neither ever names a law.
 */
export interface Feedback {
  badCells: Set<number>;
  hotHues: Set<number>;
  filled: number;
  empty: number;
  bonds: number;
  solved: boolean;
}

function asNumbers(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];
}

/**
 * `bad` is a 4096-cell mask run-length encoded with the ordinary grid codec —
 * `0` where a cell should flash — so a clean board costs four bytes instead of
 * an array of four thousand integers. `decodeGrid` is safe on this side of the
 * wire: it is a codec and knows nothing about laws.
 *
 * The plain `badCells`/`hotHues` arrays are read too, because that is how the
 * protocol document spells the same two channels and a client that only
 * understands one of the two spellings breaks on whichever it does not get.
 */
function readFeedback(v: unknown): Feedback | null {
  if (!v || typeof v !== "object") return null;
  const f = v as Record<string, unknown>;
  if (!("bad" in f || "badCells" in f || "hot" in f || "hotHues" in f)) return null;

  const badCells = new Set<number>();
  if (typeof f.bad === "string") {
    const mask = decodeGrid(f.bad);
    if (mask) for (let i = 0; i < mask.length; i++) if (mask[i] === 0) badCells.add(i);
  }
  for (const i of asNumbers(f.badCells)) badCells.add(i);

  return {
    badCells,
    hotHues: new Set<number>([...asNumbers(f.hot), ...asNumbers(f.hotHues)]),
    filled: num(f.filled),
    empty: num(f.empty),
    bonds: num(f.bonds),
    solved: f.solved === true,
  };
}

function readIssue(d: Record<string, unknown>): Issue {
  return {
    idx: num(d.idx),
    key: str(d.key),
    title: str(d.title, "Untitled board"),
    points: num(d.points),
    issuedAt: num(d.issuedAt, Date.now()),
    receipt: str(d.receipt),
    nonce: str(d.nonce),
    exec: d.exec ?? null,
    execReceipt: str(d.execReceipt),
    abandoned: typeof d.abandoned === "number" ? d.abandoned : null,
  };
}

/* ------------------------------------------------------------------ */
/* Attestation                                                         */
/* ------------------------------------------------------------------ */

export type EventKind = "stroke" | "paint" | "pick" | "undo" | "view" | "intent";

/**
 * Deliberately coarse. Anything finer — pointer coordinates, pressure, timing
 * curves — would be more for a script to forge but also more for an honest
 * harness to get wrong, and Playwright driving a real page is a first-class way
 * to play here rather than an attack.
 *
 * Shaped locally rather than imported: this is `server/attest.ts`'s private
 * vocabulary, and the whole point of the opaque envelope in `shared/protocol`
 * is that the attestation scheme can change without a protocol bump.
 */
export interface AttestedEvent {
  t: EventKind;
  at: number;
  /** Cells touched, for `stroke` and `paint`. */
  n?: number;
  /** Duration in ms, for `stroke`. */
  d?: number;
}

/** The server refuses a longer envelope, so the queue is drained in slices. */
export const MAX_BATCH = 64;

export interface Attested {
  receipt: string;
  nonce: string;
  events: number;
  feedback: Feedback | null;
  /** The next execution challenge and the tally so far. Opaque here. */
  exec: unknown;
  execReceipt: string;
}

export interface AttestBody {
  idx: number;
  receipt: string;
  nonce: string;
  events: AttestedEvent[];
  /** Omitted when the canvas has not moved: flushing events during a pause
   *  should not cost an assessment. */
  art?: string;
  /** The answer to the last challenge, omitted when the page could not produce
   *  one. An absent proof is inconclusive to the server, never an error. */
  exec?: unknown;
  execReceipt?: string;
}

/* ------------------------------------------------------------------ */
/* Submitting                                                          */
/* ------------------------------------------------------------------ */

export interface Reveal {
  title: string;
  scheme: ZoneScheme;
  rules: Rule[];
}

export interface Banked {
  accepted: true;
  alreadySolved: boolean;
  idx: number;
  key: string;
  points: number;
  bonds: number;
  parBonds: number;
  wallMs: number;
  apiCalls: number;
  events: number;
  shareId: string;
  reveal: Reveal | null;
}

export interface NotYet {
  accepted: false;
  feedback: Feedback | null;
  message: string;
}

export type SubmitOutcome = Banked | NotYet;

/* ------------------------------------------------------------------ */
/* Public art                                                          */
/* ------------------------------------------------------------------ */

export interface ArtPost {
  shareId: string;
  key: string;
  title: string;
  rules: Rule[];
  scheme: ZoneScheme;
  bondPairs: Bond[];
  parBonds: number;
  /** The harness a human vouched for, and its own note about the setup. */
  harness: string | null;
  config: string | null;
  points: number;
  bonds: number;
  art: string;
  at: number;
}

/* ------------------------------------------------------------------ */
/* The calls                                                           */
/* ------------------------------------------------------------------ */

export const api = {
  /**
   * A run declares no identity. The body is empty and the server refuses a
   * `harness` in it: the harness is whatever the human types when they vouch,
   * which is the one claim on the table nobody has a reason to fudge. An
   * operator key is that same human, already vouched for, skipping the step.
   */
  async register(operatorKey?: string): Promise<Registered> {
    const d = await call<Record<string, unknown>>(
      "/api/run",
      postJson({}, operatorKey ? { authorization: `Bearer ${operatorKey}` } : undefined),
    );
    const run = readRun(d);
    if (!run) throw new ApiError("The server registered a run it would not name.", 500);
    return { run, dialect: str(d.dialect), pairing: readPairing(d) };
  },

  async me(): Promise<RunMe> {
    const d = await call<Record<string, unknown>>("/api/run/me");
    return {
      run: readRun((d.run ?? null) as Record<string, unknown> | null),
      solved: num(d.solved),
      points: num(d.points),
      bonds: num(d.bonds),
      open: (d.open ?? null) as RunMe["open"],
      pairing: readPairing(d),
    };
  },

  /** Closes whatever is open and issues the next rung of the chain. */
  async next(): Promise<Issue> {
    return readIssue(await call<Record<string, unknown>>("/api/next", postJson({})));
  },

  async board(): Promise<Issue> {
    return readIssue(await call<Record<string, unknown>>("/api/board"));
  },

  async attest(body: AttestBody): Promise<Attested> {
    const d = await call<Record<string, unknown>>("/api/attest", postJson(body));
    return {
      receipt: str(d.receipt, body.receipt),
      nonce: str(d.nonce, body.nonce),
      events: num(d.events),
      feedback: readFeedback(d.feedback),
      // Falling back to what was sent, the way the receipt does. A server that
      // answers without an exec pair did not advance the chain either, so the
      // challenge the client is holding is still the one it owes an answer to.
      exec: d.exec ?? body.exec ?? null,
      execReceipt: str(d.execReceipt, body.execReceipt ?? ""),
    };
  },

  /**
   * Submit is also the observation channel, so a grid that is not yet a
   * solution is not an error — it is the answer to the question the submit
   * asked. The server has said that two ways during this rewrite (200 with
   * `accepted: false`, and 422 carrying `feedback`) and both mean keep
   * painting; only a body with no feedback in it at all is a real failure.
   */
  async submit(
    art: string,
    receipt: string,
    execReceipt?: string,
    meter?: MeterReport,
  ): Promise<SubmitOutcome> {
    const r = await raw(
      "/api/submit",
      postJson({
        art,
        receipt,
        // The execution tally the run accumulated on this board. The server
        // only logs its verdict today, but it cannot log a tally it was never
        // shown, and an unmeasured gate can never be turned on.
        ...(execReceipt ? { execReceipt } : {}),
        ...(meter ? { meter, ...meter } : {}),
      }),
    );
    const feedback = readFeedback(r.data.feedback) ?? readFeedback(r.data);
    if (r.data.accepted === false || (!r.ok && feedback)) {
      return {
        accepted: false,
        feedback,
        message: str(r.data.error, "That grid does not satisfy every law yet."),
      };
    }
    if (!r.ok) {
      throw new ApiError(
        str(r.data.error, "Could not submit that."),
        r.status,
        typeof r.data.code === "string" ? r.data.code : undefined,
      );
    }
    const d = r.data;
    const reveal = (d.reveal ?? null) as Reveal | null;
    return {
      accepted: true,
      alreadySolved: d.alreadySolved === true,
      idx: num(d.idx),
      key: str(d.key),
      points: num(d.points),
      bonds: num(d.bonds),
      parBonds: num(d.parBonds),
      wallMs: num(d.wallMs),
      apiCalls: num(d.apiCalls),
      events: num(d.events),
      shareId: str(d.shareId),
      reveal: reveal && Array.isArray(reveal.rules) ? reveal : null,
    };
  },

  art: (shareId: string) => call<ArtPost>(`/api/art/${shareId}`),
};
