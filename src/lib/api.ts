/**
 * Every fetch the client makes, in one place, typed against `shared/protocol`.
 *
 * The rule that shapes this file: the client does not know the laws. It used to
 * re-derive each puzzle from its seed to drive the glow, which is exactly what
 * was extracted to batch-solve a thousand boards. So the two feedback channels
 * arrive over the wire, and this module is where they are turned back into the
 * `Set<number>`s the canvas and the palette have always drawn.
 *
 * Nothing here imports the generator, the validator or the dialect. If it ever
 * does, the benchmark is over.
 *
 * The page is now a *client* of the agent API rather than a privileged surface
 * on top of it: it registers a run, takes a puzzle, and submits grids, exactly
 * as a runner script does. There is no attestation, no pairing and no endpoint
 * a browser can reach that an HTTP client cannot.
 */

import { GRID } from "@shared/palette";
import { HUES } from "@shared/palette";
import type { Feedback as WireFeedback, MeterReport, RunStatus } from "@shared/protocol";
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
 * `credentials: "same-origin"` is the whole authentication story for the page:
 * the run token lives in an HttpOnly `pixe_run` cookie, so the browser never
 * holds it. A script sends `Authorization: Bearer` instead.
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

const postJson = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
});

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" ? v : fallback);

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

export interface RunSummary {
  runId: string;
  /** Declared at registration and never verified. The two columns a leaderboard
   *  groups on; `config` is prose and ranks nothing. */
  model: string;
  provider: string;
  config: string | null;
  createdAt: number;
  status: RunStatus;
}

export interface RunMe {
  run: RunSummary | null;
  solved: number;
  points: number;
  bonds: number;
  open: { idx: number; key: string; issuedAt: number } | null;
}

/** Where the page remembers which run it is, since the token is HttpOnly and
 *  every run-scoped path names the run. */
const RUN_STASH = "pixe:runId";

export const storedRunId = (): string | null => localStorage.getItem(RUN_STASH);

function readRun(d: Record<string, unknown> | null): RunSummary | null {
  if (!d) return null;
  const id = str(d.runId);
  if (!id) return null;
  return {
    runId: id,
    model: str(d.model, "unnamed"),
    provider: str(d.provider, "unnamed"),
    config: typeof d.config === "string" ? d.config : null,
    createdAt: num(d.createdAt),
    status: str(d.status, "open") as RunStatus,
  };
}

/* ------------------------------------------------------------------ */
/* The board and its feedback                                          */
/* ------------------------------------------------------------------ */

/** The open puzzle. Structure only — no seed, no scheme, no laws. */
export interface Issue {
  idx: number;
  key: string;
  title: string;
  points: number;
  issuedAt: number;
}

/**
 * The two channels, in the shape the canvas and the palette have always drawn:
 * flashing cell indices and buzzing hue ids. The wire speaks in coordinates and
 * colour names, so this is where the translation happens — one direction, in
 * one place.
 */
export interface Feedback {
  badCells: Set<number>;
  hotHues: Set<number>;
  filled: number;
  empty: number;
  bonds: number;
  solved: boolean;
}

const HUE_BY_NAME = new Map(HUES.map((h) => [h.name, h.id]));

function readFeedback(d: Record<string, unknown>, solved: boolean): Feedback {
  const wire = (d.feedback ?? {}) as Partial<WireFeedback>;
  const badCells = new Set<number>();
  if (Array.isArray(wire.flashes)) {
    for (const f of wire.flashes) {
      if (f && typeof f.x === "number" && typeof f.y === "number") badCells.add(f.y * GRID + f.x);
    }
  }
  const hotHues = new Set<number>();
  if (Array.isArray(wire.buzzes)) {
    for (const name of wire.buzzes) {
      const id = HUE_BY_NAME.get(name);
      if (id !== undefined) hotHues.add(id);
    }
  }
  return {
    badCells,
    hotHues,
    filled: num(d.filled),
    empty: num(d.empty),
    bonds: num(d.bonds),
    solved,
  };
}

function readIssue(d: Record<string, unknown>): Issue {
  return {
    idx: num(d.idx),
    key: str(d.key),
    title: str(d.title, "Untitled board"),
    points: num(d.points),
    issuedAt: num(d.issuedAt, Date.now()),
  };
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
  probes: number;
  shareId: string;
  reveal: Reveal | null;
}

export interface NotYet {
  accepted: false;
  feedback: Feedback;
  probes: number;
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
  /** Declared by the run, unverified. */
  model: string;
  provider: string;
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
   * A run declares a model and a provider, both required and neither checked.
   * That is the whole of registration — no key, no signup, and nothing to
   * arrange out of band.
   */
  async register(model: string, provider: string, config?: string): Promise<RunSummary> {
    const d = await call<Record<string, unknown>>(
      "/api/bench/runs",
      postJson({ model, provider, ...(config ? { config } : {}) }),
    );
    const run = readRun(d);
    if (!run) throw new ApiError("The server registered a run it would not name.", 500);
    localStorage.setItem(RUN_STASH, run.runId);
    return run;
  },

  async me(): Promise<RunMe> {
    const id = storedRunId();
    const empty: RunMe = { run: null, solved: 0, points: 0, bonds: 0, open: null };
    if (!id) return empty;
    try {
      const d = await call<Record<string, unknown>>(`/api/bench/runs/${id}`);
      return {
        run: readRun(d),
        solved: num(d.solved),
        points: num(d.points),
        bonds: num(d.bonds),
        open: (d.open ?? null) as RunMe["open"],
      };
    } catch (err) {
      // A run the cookie can no longer authenticate is a run this browser has
      // lost. There is no recovery, so forget it rather than loop on a 401.
      if (err instanceof ApiError && err.status === 401) localStorage.removeItem(RUN_STASH);
      return empty;
    }
  },

  /** Issues the next rung of the chain. Refuses while a board is open. */
  async next(runId: string): Promise<Issue> {
    return readIssue(await call<Record<string, unknown>>(`/api/bench/runs/${runId}/next`, postJson({})));
  },

  /** Drops the open board. Charged to the run, and refused for the first minute. */
  async abandon(runId: string): Promise<void> {
    await call(`/api/bench/runs/${runId}/abandon`, postJson({}));
  },

  /**
   * Submit is also the observation channel, so a grid that is not yet a
   * solution is not an error — it is the answer to the question the submit
   * asked, and it costs a probe.
   */
  async submit(runId: string, grid: string[], meter?: MeterReport): Promise<SubmitOutcome> {
    const d = await call<Record<string, unknown>>(
      `/api/bench/runs/${runId}/submit`,
      postJson({ grid, ...(meter ? { meter } : {}) }),
    );
    if (d.accepted === false) {
      return {
        accepted: false,
        feedback: readFeedback(d, false),
        probes: num(d.probes),
        message: "That grid does not satisfy every law yet.",
      };
    }
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
      probes: num(d.probes),
      shareId: str(d.shareId),
      reveal: reveal && Array.isArray(reveal.rules) ? reveal : null,
    };
  },

  art: (shareId: string) => call<ArtPost>(`/api/art/${shareId}`),
};
