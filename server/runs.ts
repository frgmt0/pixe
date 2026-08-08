/**
 * The whole benchmark loop: register a run, take a puzzle, answer it, abandon
 * it. Four POSTs and one GET, all JSON, all under `/api/bench/runs`.
 *
 * This is also the file that makes batch solving arithmetically unavailable
 * rather than merely detected. A run never picks a puzzle key. The server issues
 * them one at a time, and the key for puzzle n+1 is derived by HMAC from the run
 * secret and the digest of the *accepted* grid for puzzle n:
 *
 *     key(0)   = HMAC(secret, "pixe/seq/0")
 *     key(n+1) = HMAC(secret, "pixe/seq/" + n + ":" + solutionDigest(n))
 *
 * Neither term is available early. The secret never leaves the database, and
 * the digest does not exist until a grid has passed the validator. So there is
 * no request an agent can make, in any order, that reveals puzzle n+1 before it
 * has genuinely solved puzzle n — and with one open issue per run enforced by a
 * partial unique index, there is no second puzzle to work on in the meantime.
 *
 * Everything else in this file — the difficulty band, the collision retry, the
 * per-issue call ceiling — is bookkeeping around that one property.
 *
 * What is *not* here any more: pairing, attestation, exec-binding. The browser
 * is no longer part of what is measured, so an agent talks to this file and
 * nothing else. `docs/THREAT-MODEL.md` states the resulting trust model plainly.
 */

import { decodeGrid, encodeGrid } from "../shared/codec";
import { assessPhase, dialectPhase, newDialectSalt } from "../shared/dialect";
import { LADDER_SIZE, phaseCountFor } from "../shared/generate";
import { CELLS, GRID } from "../shared/palette";
import {
  boardPalette,
  feedbackFrom,
  parseRegisterRun,
  parseSubmit,
  PROTOCOL_VERSION,
  runCookie,
  runTokenFrom,
  type AbandonResult,
  type PuzzleIssued,
  type RunRegistered,
  type RunState,
  type SubmitAccepted,
  type SubmitRejected,
} from "../shared/protocol";
import { buzzedHues, type Grid } from "../shared/rules";
import type { Assessment } from "../shared/validate";
import { hmac, randB64, randHex, sameString, sha256Hex } from "./crypto";
import type { IssueRow, NewRunSolve, RunRow, Store } from "./store";

/** Structurally what `router.ts` already threads through. Assignable from its `Deps`. */
export interface RunDeps {
  store: Store;
  ip: string;
  secure: boolean;
}

/** The width of the ladder, defined once in `shared/generate.ts`. */
const LADDER_MAX = LADDER_SIZE;

/**
 * Submitting is the feedback oracle, so it gets a budget. Generous for real
 * deduction — a careful agent settles a board in tens of submits, not hundreds —
 * and far too small to walk a solver to the law set one cell at a time.
 *
 * Charged per *phase*, not per rung: a three-phase rung is three boards' worth
 * of deduction and clipping it to one board's budget would make the top of the
 * ladder unplayable rather than hard.
 */
const MAX_CALLS_PER_PHASE = 600;

/**
 * Abandoning a puzzle you do not like is allowed but must cost more than
 * solving it. Without this an agent could shop the difficulty band by taking
 * and dropping boards in a loop until it drew something easy.
 */
const ABANDON_MIN_MS = 60_000;

/** Run creation is unauthenticated, so it is the one thing throttled per IP. */
const RUN_WINDOW_MS = 60 * 60 * 1000;
const MAX_RUNS_PER_IP = 60;

/** A 64-row grid of 64 characters is ~4KB; a run-length string is far less. */
const MAX_BODY = 256 * 1024;

/* ------------------------------------------------------------------ */
/* Plumbing                                                            */
/* ------------------------------------------------------------------ */

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

const fail = (status: number, error: string, code: string) => json({ error, code }, { status });

async function readJson(req: Request): Promise<unknown> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return null;
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Run tokens                                                          */
/* ------------------------------------------------------------------ */

/**
 * A run token is the run id plus an HMAC of it under a key derived from that
 * run's secret. Self-validating: there is no session table to sweep, and a
 * token cannot outlive the row it names because verification reads the row to
 * get the key it was signed with.
 */
export async function mintToken(run: RunRow): Promise<string> {
  return `r1.${run.id}.${await hmac(run.secret, `pixe/token/1:${run.id}`)}`;
}

/**
 * The run for a `/api/bench/runs/:id/...` route, or the response that refuses.
 *
 * Header or cookie, both accepted and the header wins — see `runTokenFrom`.
 *
 * The token already names a run, so `:id` is checked against it rather than
 * looked up: a valid token for run A must not be able to act on run B, and
 * answering `no_run` rather than "wrong run" keeps the route from confirming
 * that some other id exists.
 *
 * A run that is closed or void is told so specifically, because that is a
 * different problem from a bad credential and needs a different fix — the token
 * is fine, the run is over. Reaching the row at all requires a valid token for
 * it, so the distinction leaks nothing.
 */
async function runForPath(
  store: Store,
  req: Request,
  id: string,
): Promise<{ run: RunRow } | { refusal: Response }> {
  const token = runTokenFrom(req);
  const parts = token ? token.split(".") : [];
  if (parts.length === 3 && parts[0] === "r1" && parts[1] === id) {
    const row = await store.runById(id);
    if (row && sameString(await hmac(row.secret, `pixe/token/1:${row.id}`), parts[2]!)) {
      if (row.status !== "open") {
        return {
          refusal: fail(403, `This run is ${row.status}. Register another to keep going.`, "run_closed"),
        };
      }
      return { run: row };
    }
  }
  return { refusal: noRun() };
}

const noRun = () =>
  fail(
    401,
    "Send the runToken you were given: `Authorization: Bearer <runToken>`. Register at POST /api/bench/runs.",
    "no_run",
  );

/* ------------------------------------------------------------------ */
/* The chained sequence                                                */
/* ------------------------------------------------------------------ */

/**
 * The difficulty band for chain position `idx`.
 *
 * A uniform draw over the whole ladder would put every puzzle in the
 * generator's top tier from the first one — three interlocking phases and
 * eleven exotic laws before an agent has seen a single flash — which is both a
 * brutal opening and a dead benchmark, since the most interesting signal on the
 * chart is wall clock against chain position and that curve needs somewhere to
 * start. So the band's ceiling widens geometrically with position: positions
 * 0-5 walk the generator's own tier boundaries, then the ceiling grows ~18% per
 * puzzle and reaches the full ladder at about position 24.
 *
 * Every bound is a fraction of `LADDER_SIZE` rather than a literal rung number,
 * so renumbering the ladder moves this curve with it instead of stranding the
 * top half of the boards out of reach.
 *
 * Widening rather than sliding, deliberately: the floor stays low so a long run
 * keeps drawing from the whole space rather than marching off into a corner of
 * it, and the draw stays unpredictable because the band is public but the HMAC
 * that picks within it is not.
 */
export function bandFor(idx: number): { lo: number; hi: number } {
  const L = LADDER_MAX;
  if (idx <= 0) return { lo: 1, hi: Math.max(3, Math.round(L * 0.006)) };
  if (idx <= 2) return { lo: 4, hi: Math.max(10, Math.round(L * 0.02)) };
  if (idx <= 5) return { lo: 11, hi: Math.max(25, Math.round(L * 0.05)) };
  const floor = Math.max(26, Math.round(L * 0.05) + 1);
  const hi = Math.min(L, Math.round(floor * Math.pow(1.18, idx - 5)));
  return { lo: floor, hi: Math.max(floor + 1, hi) };
}

/**
 * Digest of an accepted grid, canonicalised first.
 *
 * The stored `art` is already the server's own encoding, so the round trip is
 * belt and braces — but the codec accepts non-canonical encodings (`a1a1`
 * decodes the same as `a2`), and a digest that depended on which of them it was
 * handed would be a way to shop for the next key. Canonicalising here means it
 * cannot become one if the storage path ever changes.
 */
export async function solutionDigest(idx: number, art: string): Promise<string> {
  const grid = decodeGrid(art);
  return sha256Hex(`pixe/sol/1:${idx}:${grid ? encodeGrid(grid) : art}`);
}

/**
 * Map an HMAC onto a ladder key inside the band. `bump` only moves off a key
 * this run has already banked — see `nextKey`.
 */
async function keyAt(secret: string, idx: number, prevDigest: string, bump: number): Promise<string> {
  const base = idx === 0 ? "pixe/seq/0" : `pixe/seq/${idx - 1}:${prevDigest}`;
  const mac = await hmac(secret, bump === 0 ? base : `${base}#${bump}`);
  // 48 bits off the front of the digest, which is far more than the ~20 the
  // band ever needs; the modulo bias against a range under 10^6 is unmeasurable.
  let n = 0;
  for (let i = 0; i < 8; i++) n = n * 64 + b64Value(mac.charCodeAt(i));
  const { lo, hi } = bandFor(idx);
  return `L${lo + (n % (hi - lo + 1))}`;
}

function b64Value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 97 + 26;
  if (code >= 48 && code <= 57) return code - 48 + 52;
  return code === 45 ? 62 : 63;
}

/**
 * The next key in the chain, skipping anything this run has already banked.
 *
 * The band is narrow early — position 0 draws from three keys — so a repeat is
 * not a curiosity, it is expected, and a repeat would let a run re-solve a
 * board it has already seen for free. The bump counter feeds the derivation
 * string, so the retry is as deterministic and as unpredictable as the first
 * attempt.
 *
 * Only banked keys are avoided. An abandoned puzzle was never solved, so
 * drawing it again costs the agent the same work it dodged.
 */
export async function nextKey(store: Store, run: RunRow, idx: number): Promise<string> {
  const solves = await store.runSolves(run.id);
  const banked = new Set(solves.map((s) => s.puzzle_key));
  // The contract's digest term: the solution to the puzzle before this one. An
  // abandoned position leaves no digest, so the chain carries the most recent
  // accepted one forward rather than stalling.
  const prev = solves.length ? solves[solves.length - 1]! : null;
  const digest = prev ? await solutionDigest(prev.idx, prev.art) : "-";

  for (let bump = 0; bump < 64; bump++) {
    const key = await keyAt(run.secret, idx, digest, bump);
    if (!banked.has(key)) return key;
  }
  // 64 collisions in a row means the band is exhausted, which only happens to a
  // run that has banked every key in it. Widen past the band rather than fail.
  return `L${26 + ((idx * 7919) % (LADDER_MAX - 26))}`;
}

/* ------------------------------------------------------------------ */
/* Projections                                                         */
/* ------------------------------------------------------------------ */

/**
 * The whole of what an agent is told about the board it was just handed.
 *
 * Absent, permanently: the seed, the dialect salt, the zone scheme, the hue set
 * and the rules. What is here is structure — how big the board is, which
 * colours exist, what the rung is worth — none of which narrows the law space.
 */
function puzzlePayload(run: RunRow, issue: IssueRow, phase = phaseOf(issue), priors = priorsOf(issue)): PuzzleIssued {
  const { puzzle } = dialectPhase(run.dialect, issue.puzzle_key, phase, priors);
  return {
    protocol: PROTOCOL_VERSION,
    runId: run.id,
    idx: issue.idx,
    key: issue.puzzle_key,
    puzzleId: `${run.id}:${issue.idx}`,
    title: puzzle.title,
    width: GRID,
    height: GRID,
    cells: CELLS,
    palette: boardPalette(),
    points: puzzle.points,
    issuedAt: issue.issued_at,
    rowMajor: true,
    phase: puzzle.phase,
    phases: puzzle.phases,
    locked: puzzle.locked,
  };
}

/** Which link of the rung is open. A single-phase rung never leaves 1. */
const phaseOf = (issue: IssueRow): number => Math.max(1, issue.phase || 1);

/**
 * The accepted grids for every phase of this rung that is already finished.
 *
 * These are the derivation inputs for the phase currently open, so this is not
 * a log — it is state the laws depend on, and the reason `phase_grids` is a
 * column rather than something recomputed.
 */
function priorsOf(issue: IssueRow): Grid[] {
  if (!issue.phase_grids) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(issue.phase_grids);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Grid[] = [];
  for (const s of parsed) {
    const g = decodeGrid(s);
    if (g) out.push(g);
  }
  return out;
}

/**
 * What the whole rung pays: the sum over its phases, each computed from that
 * phase's own rule weights.
 *
 * Rebuilt from the seed and the accepted grids rather than accumulated as the
 * agent goes, so the figure a rung banks is derived by the same code path that
 * derived the boards, and a tampered column could not change it.
 */
function rungPoints(salt: string, key: string, grids: Grid[]): number {
  let total = 0;
  for (let p = 1; p <= grids.length; p++) {
    total += dialectPhase(salt, key, p, grids.slice(0, p - 1)).puzzle.points;
  }
  return total;
}

/**
 * The two feedback channels, computed server-side and published as coordinates
 * and colour names.
 *
 * Built from the `broken` verdicts only, and that is the silence rule made
 * mechanical rather than promised. `RuleEval` distinguishes `broken` — wrong
 * right now — from `pending` — not satisfied but still reachable — and a
 * `pending` counting law must not buzz: the board does not nag about a
 * requirement the agent could still go on to meet, and a swatch that reacts to
 * an unfinished quota would be indistinguishable from one reacting to a
 * genuinely violated one.
 *
 * The invariant this must not break, pinned by `shared/engine.test.ts`: on a
 * *full* grid nothing is merely pending, because there is nowhere left to put
 * the missing paint — every unmet counting law is `broken` and therefore
 * visible. So silence on a full grid means solved, and no failing law is ever
 * invisible. Every `pending` verdict carries an empty `violations` array, so
 * the cell channel is unaffected by this filter.
 *
 * `RuleEval.progress` is deliberately not forwarded either. Its `need` field is
 * the literal threshold of a counting law, and shipping that would put the rule
 * text back on the wire in numeric form.
 */
function feedbackFor(a: Assessment) {
  const buzzing = new Set<number>();
  const flashing = new Set<number>();
  for (const ev of a.evals) {
    if (ev.status !== "broken") continue;
    for (const c of ev.violations) flashing.add(c);
    for (const h of buzzedHues(ev)) buzzing.add(h);
  }
  return feedbackFrom(flashing, buzzing);
}

const dialectLabel = async (secret: string) =>
  `d-${(await hmac(secret, "pixe/dialect-label/1")).slice(0, 8)}`;

function shareId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    b.toString(36).padStart(2, "0"),
  ).join("").slice(0, 12);
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

/**
 * `POST /api/bench/runs` — register.
 *
 * The body names the model and the provider. Nothing checks either, and the
 * threat model says so in those words: this is a declared identity, recorded
 * exactly as given, and every column that ranks anything is measured instead.
 */
export async function postRun(req: Request, _url: URL, deps: RunDeps): Promise<Response> {
  const { store, ip, secure } = deps;
  const now = Date.now();

  // Database-backed rather than a `Map`: on Workers requests land in whichever
  // isolate is warm, so an in-memory counter does not throttle, it merely
  // appears to.
  if ((await store.attemptCount(`run:${ip}`, now)) >= MAX_RUNS_PER_IP) {
    return fail(429, "Too many runs registered from here. Wait a while.", "rate_limited");
  }
  await store.noteAttempt(`run:${ip}`, now, RUN_WINDOW_MS);

  const parsed = parseRegisterRun(await readJson(req));
  if (!parsed.ok) return fail(400, parsed.error, parsed.code);

  const secret = randHex(32);
  const run = await store.createRun({
    id: randB64(12),
    secret,
    model: parsed.value.model,
    provider: parsed.value.provider,
    config: parsed.value.config,
    dialect: newDialectSalt(),
    created_at: now,
    last_at: now,
    status: "open",
  });

  const token = await mintToken(run);
  const body: RunRegistered = {
    protocol: PROTOCOL_VERSION,
    runId: run.id,
    runToken: token,
    model: run.model,
    provider: run.provider,
    config: run.config,
    // NOT the dialect salt. A client holding the salt can re-derive every law in
    // the run. This is a stable public name for the dialect, so two runs can be
    // told apart without either being handed the other's board.
    dialect: await dialectLabel(secret),
    status: run.status,
    createdAt: run.created_at,
  };
  return json(body, { status: 201, headers: { "set-cookie": runCookie(token, secure) } });
}

/** `GET /api/bench/runs/:id` — who am I and how far along. */
export async function getRun(req: Request, id: string, deps: RunDeps): Promise<Response> {
  const authed = await runForPath(deps.store, req, id);
  if ("refusal" in authed) return authed.refusal;
  const run = authed.run;
  const [solves, open] = await Promise.all([
    deps.store.runSolves(run.id),
    deps.store.openIssue(run.id),
  ]);
  const body: RunState = {
    protocol: PROTOCOL_VERSION,
    runId: run.id,
    model: run.model,
    provider: run.provider,
    config: run.config,
    dialect: await dialectLabel(run.secret),
    status: run.status,
    createdAt: run.created_at,
    lastAt: run.last_at,
    solved: solves.length,
    points: solves.reduce((s, r) => s + r.points, 0),
    bonds: solves.reduce((s, r) => s + r.bonds, 0),
    open: open
      ? {
          idx: open.idx,
          key: open.puzzle_key,
          issuedAt: open.issued_at,
          phase: phaseOf(open),
          phases: phaseCountFor(open.puzzle_key),
        }
      : null,
  };
  return json(body);
}

/**
 * `POST /api/bench/runs/:id/next` — issue the next puzzle in the chain.
 *
 * The clock for a puzzle starts when its row is written, and the row is written
 * before the board is derived, so `issued_at` always precedes the moment the
 * agent could first have seen anything about the board. There is no ordering of
 * requests that gets content out ahead of the timestamp.
 *
 * One puzzle at a time, and this route will not take one away from you: an open
 * board answers `409` naming the rung. Dropping it is `/abandon`, which is a
 * separate request precisely so that walking away is a decision rather than a
 * side effect of asking for work.
 */
export async function postNext(req: Request, id: string, deps: RunDeps): Promise<Response> {
  const { store } = deps;
  const authed = await runForPath(store, req, id);
  if ("refusal" in authed) return authed.refusal;
  const run = authed.run;
  const now = Date.now();

  const open = await store.openIssue(run.id);
  if (open) {
    await store.bumpCalls(run.id, open.idx);
    // The payload rides along so a runner that crashed mid-rung can pick the
    // board back up. It reveals nothing `next` would not have: no seed, no
    // laws — and on a later phase it carries the locked cells, which the agent
    // has to have and cannot otherwise recover.
    return json(
      {
        error: `Rung ${open.idx} is still open. Solve it, or POST .../abandon to drop it.`,
        code: "open_issue",
        idx: open.idx,
        key: open.puzzle_key,
        issuedAt: open.issued_at,
        phase: phaseOf(open),
        phases: phaseCountFor(open.puzzle_key),
        open: puzzlePayload(run, open),
      },
      { status: 409 },
    );
  }

  const idx = await store.nextIdx(run.id);
  const key = await nextKey(store, run, idx);
  const issue = await store.insertIssue(run.id, idx, key, now);
  await store.touchRun(run.id, now);

  return json(puzzlePayload(run, issue));
}

/**
 * `POST /api/bench/runs/:id/abandon` — drop the open board.
 *
 * Kept as its own endpoint, and kept expensive. The board must have been held
 * for `ABANDON_MIN_MS` first, so a reroll loop cannot run faster than a minute a
 * board; and every millisecond of it lands in `effective_ms_per_solve`'s
 * numerator while the board adds nothing to its denominator. Abandoning is a
 * legitimate move with a legible price, which is the only kind of move a
 * benchmark can afford to allow.
 *
 * It does not issue the next rung, and it does not re-roll the one you left:
 * `nextIdx()` is `MAX(idx) + 1` over every issue, so an abandoned rung consumes
 * its number exactly like a solved one, and the band you draw from next is
 * wider — abandoning walks you into harder boards, not easier ones.
 */
export async function postAbandon(req: Request, id: string, deps: RunDeps): Promise<Response> {
  const { store } = deps;
  const authed = await runForPath(store, req, id);
  if ("refusal" in authed) return authed.refusal;
  const run = authed.run;

  const issue = await store.openIssue(run.id);
  if (!issue) return fail(404, "No open puzzle to abandon.", "no_open_issue");
  await store.bumpCalls(run.id, issue.idx);

  const now = Date.now();
  const held = now - issue.issued_at;
  if (held < ABANDON_MIN_MS) {
    const wait = ABANDON_MIN_MS - held;
    return json(
      {
        error: "Hold a board for a minute before dropping it.",
        code: "rate_limited",
        retryAfterMs: wait,
        idx: issue.idx,
      },
      { status: 429, headers: { "retry-after": String(Math.ceil(wait / 1000)) } },
    );
  }

  await store.closeIssue(run.id, issue.idx, now, "abandoned");
  await store.touchRun(run.id, now);
  const body: AbandonResult = { abandoned: issue.idx, heldMs: held, charged: true };
  return json(body);
}

/**
 * `POST /api/bench/runs/:id/submit` — answer the open board, or probe it.
 *
 * The two branches are one endpoint on purpose. A grid that is not yet a
 * solution comes back `200` with `accepted: false` and the two feedback
 * channels attached, because that feedback is the entire teaching mechanism —
 * there is no hint endpoint, no rule text, and nothing cheaper to probe than
 * painting and asking. Every such submit is counted as a probe, and `4xx` is
 * reserved for a grid the server could not read at all.
 *
 * The agent is trusted with pixels and with three numbers it declares about
 * itself. Everything that ranks anything — points, bonds, difficulty, wall
 * clock, call and probe counts — is computed here.
 */
export async function postSubmit(req: Request, id: string, deps: RunDeps): Promise<Response> {
  const { store } = deps;
  const authed = await runForPath(store, req, id);
  if ("refusal" in authed) return authed.refusal;
  const run = authed.run;
  const issue = await store.openIssue(run.id);
  if (!issue) {
    return fail(404, "No open puzzle. POST .../next for one.", "no_open_issue");
  }

  const phase = phaseOf(issue);
  const phases = phaseCountFor(issue.puzzle_key);
  const priors = priorsOf(issue);

  await store.bumpCalls(run.id, issue.idx);
  const calls = await store.callCount(run.id, issue.idx);
  const budget = MAX_CALLS_PER_PHASE * phases;
  if (calls > budget) {
    return fail(
      429,
      `This rung has had its ${budget} round trips. Abandon it, or finish it in one.`,
      "rate_limited",
    );
  }

  const parsed = parseSubmit(await readJson(req));
  if (!parsed.ok) return fail(parsed.code === "bad_grid" ? 422 : 400, parsed.error, parsed.code);
  const { grid, meter } = parsed.value;

  const now = Date.now();
  // Re-derived from the run's dialect, the key, the phase and the agent's own
  // accepted grids for the phases before it, then re-validated with the same
  // shared engine every other caller uses. Nothing about the verdict comes from
  // the request except the pixels.
  const result = assessPhase(run.dialect, issue.puzzle_key, phase, priors, grid);

  if (!result.solved) {
    // A rejected submit taught the agent something, so it costs a probe. The
    // accepted one does not: nothing is learned from being told you are done,
    // and charging for it would make a perfect first-try solve look like a
    // guess rather than the best possible result.
    await store.bumpProbes(run.id, issue.idx);
    await store.touchRun(run.id, now);
    const body: SubmitRejected = {
      accepted: false,
      idx: issue.idx,
      key: issue.puzzle_key,
      phase,
      phases,
      filled: result.filled,
      empty: result.empty,
      feedback: feedbackFor(result),
      bonds: result.bonds,
      apiCalls: calls,
      probes: await store.probeCount(run.id, issue.idx),
    };
    return json(body);
  }

  const accepted = [...priors, Int8Array.from(grid)];
  const probes = await store.probeCount(run.id, issue.idx);

  /* --- a phase handoff, not the end of the rung --------------------- */
  if (phase < phases) {
    // The grid is banked into the issue, the phase counter moves, and the next
    // board is derived from what was just accepted and returned in this same
    // response. The issue stays open and `issued_at` is untouched, so the clock
    // spans the rung.
    await store.advancePhase(
      run.id,
      issue.idx,
      phase + 1,
      JSON.stringify(accepted.map((g) => encodeGrid(g))),
    );
    await store.touchRun(run.id, now);
    const solves = await store.runSolves(run.id);
    const body: SubmitAccepted = {
      accepted: true,
      idx: issue.idx,
      key: issue.puzzle_key,
      phase,
      phases,
      rungComplete: false,
      alreadySolved: false,
      phasePoints: result.puzzle.points,
      points: 0,
      bonds: result.bonds,
      parBonds: result.puzzle.parBonds,
      difficulty: Math.round(result.puzzle.difficulty),
      shareId: null,
      wallMs: Math.max(0, now - issue.issued_at),
      apiCalls: calls,
      probes,
      solved: solves.length,
      totalPoints: solves.reduce((s, r) => s + r.points, 0),
      next: puzzlePayload(run, issue, phase + 1, accepted),
      // No reveal until the rung is banked: the laws of phase 1 are still doing
      // work, because phase 2's board was derived from the answer to them.
      reveal: null,
    };
    return json(body);
  }

  /* --- the final phase: bank the rung ------------------------------- */

  // Idempotent: the check and the insert are not in one transaction, so two
  // submissions racing each other must not both bank, and a write that commits
  // without answering must stay retryable.
  const existing = await store.solveAt(run.id, issue.idx);
  if (existing) {
    const solves = await store.runSolves(run.id);
    const body: SubmitAccepted = {
      accepted: true,
      idx: existing.idx,
      key: existing.puzzle_key,
      phase,
      phases,
      rungComplete: true,
      alreadySolved: true,
      phasePoints: result.puzzle.points,
      points: 0,
      bonds: existing.bonds,
      parBonds: result.puzzle.parBonds,
      difficulty: existing.difficulty,
      shareId: existing.share_id,
      wallMs: existing.wall_ms,
      apiCalls: existing.api_calls,
      probes: existing.probes,
      solved: solves.length,
      totalPoints: solves.reduce((s, r) => s + r.points, 0),
      next: null,
      reveal: null,
    };
    return json(body);
  }

  const row: NewRunSolve = {
    run_id: run.id,
    idx: issue.idx,
    puzzle_key: issue.puzzle_key,
    // Every phase's points, summed — and recomputed here from the seed and the
    // accepted grids rather than accumulated across requests, so the figure a
    // rung banks comes out of the same code that derived the boards.
    points: rungPoints(run.dialect, issue.puzzle_key, accepted),
    bonds: result.bonds,
    difficulty: Math.round(result.puzzle.difficulty),
    wall_ms: Math.max(0, now - issue.issued_at),
    api_calls: calls,
    probes,
    tokens_in: meter?.tokensIn ?? null,
    tokens_out: meter?.tokensOut ?? null,
    cost_micro: meter?.costMicro ?? null,
    // The final phase's grid is the art, and the term the chain digests.
    art: encodeGrid(grid),
    share_id: shareId(),
    created_at: now,
  };
  const solve = await store.insertRunSolve(row);
  await store.closeIssue(run.id, issue.idx, now, "solved");
  await store.touchRun(run.id, now);

  const solves = await store.runSolves(run.id);
  const body: SubmitAccepted = {
    accepted: true,
    idx: solve.idx,
    key: solve.puzzle_key,
    phase,
    phases,
    rungComplete: true,
    alreadySolved: false,
    phasePoints: result.puzzle.points,
    points: solve.points,
    bonds: solve.bonds,
    parBonds: result.puzzle.parBonds,
    difficulty: solve.difficulty,
    shareId: solve.share_id,
    wallMs: solve.wall_ms,
    apiCalls: solve.api_calls,
    probes: solve.probes,
    solved: solves.length,
    totalPoints: solves.reduce((s, r) => s + r.points, 0),
    next: null,
    // The post-solve reveal, and every phase of it at once. Safe now and only
    // now: this rung is banked, and the next key is unreachable without the run
    // secret regardless of what the agent learns about this one.
    reveal: revealFor(run.dialect, issue.puzzle_key, accepted),
  };
  return json(body);
}

/** Every phase's laws, in order, for the response that banks the rung. */
function revealFor(salt: string, key: string, grids: Grid[]): SubmitAccepted["reveal"] {
  const phases = grids.map((_, k) => {
    const { puzzle } = dialectPhase(salt, key, k + 1, grids.slice(0, k));
    return { phase: k + 1, title: puzzle.title, scheme: puzzle.scheme, rules: puzzle.rules as unknown[] };
  });
  const last = phases[phases.length - 1]!;
  return { title: last.title, scheme: last.scheme, rules: last.rules, phases };
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

const RUN_PATH = /^\/api\/bench\/runs\/([A-Za-z0-9_-]{1,32})(?:\/(next|submit|abandon))?$/;

/**
 * Every run-scoped route, for `router.ts` to hang off `handleApi`. Returns
 * `null` for a path this module does not own, so the caller can fall through.
 */
export async function handleRunApi(req: Request, url: URL, deps: RunDeps): Promise<Response | null> {
  const p = url.pathname;
  const post = req.method === "POST";

  if (p === "/api/bench/runs") {
    return post ? postRun(req, url, deps) : fail(405, "POST to register a run.", "bad_request");
  }

  const m = RUN_PATH.exec(p);
  if (!m) return null;
  const id = m[1]!;
  const action = m[2];

  if (!action) {
    return req.method === "GET"
      ? getRun(req, id, deps)
      : fail(405, "GET for run state.", "bad_request");
  }
  if (!post) return fail(405, "POST only.", "bad_request");
  if (action === "next") return postNext(req, id, deps);
  if (action === "submit") return postSubmit(req, id, deps);
  return postAbandon(req, id, deps);
}
