/**
 * Run lifecycle and the chained puzzle sequence.
 *
 * This is the file that makes batch solving arithmetically unavailable rather
 * than merely detected. A run never picks a puzzle key. The server issues them
 * one at a time, and the key for puzzle n+1 is derived by HMAC from the run
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
 * The 1105-solves attack is not blocked here; it is unrepresentable.
 *
 * Everything else in this file — the difficulty band, the collision retry, the
 * per-issue call ceiling — is bookkeeping around that one property.
 */

import { decodeGrid, encodeGrid } from "../shared/codec";
import { assessDialect, dialectPuzzle } from "../shared/dialect";
import { GRID } from "../shared/palette";
import type { Grid } from "../shared/rules";
import type { Assessment } from "../shared/validate";
import {
  bindReceipt,
  gateSubmit,
  hmac,
  nonceFor,
  openReceipt,
  sameString,
  sha256Hex,
  verifyAttest,
} from "./attest";
import {
  execChallenge,
  gateExec,
  openExecReceipt,
  readExecReceipt,
  verifyExecProof,
} from "./exec-bind";
import type { IssueRow, NewRunSolve, RunRow, Store } from "./store";

/** Structurally what `router.ts` already threads through. Assignable from its `Deps`. */
export interface RunDeps {
  store: Store;
  ip: string;
  secure: boolean;
}

const COOKIE = "pixe_run";
const RUN_MS = 30 * 24 * 60 * 60 * 1000;

/** `isValidKey` accepts L1..L999999, so this is the real width of the ladder. */
const LADDER_MAX = 999_999;

/**
 * The feedback endpoint is an oracle about the open board, so it gets a budget.
 * Generous for play — a human or agent painting 4096 cells settles a few
 * hundred times — and far too small to run a solver that wants to probe its way
 * to the law set one cell at a time.
 */
const MAX_CALLS_PER_ISSUE = 600;

/**
 * Rerolling a puzzle you do not like is allowed but must cost more than
 * solving it. Without this an agent could shop the difficulty band by calling
 * `/api/next` in a loop until it drew something easy.
 */
const ABANDON_MIN_MS = 60_000;

const MAX_BODY = 64 * 1024;

/* ------------------------------------------------------------------ */
/* Plumbing                                                            */
/* ------------------------------------------------------------------ */

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

const fail = (status: number, error: string) => json({ error }, { status });

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return null;
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
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

export function runCookie(token: string, secure: boolean): string {
  const parts = [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(RUN_MS / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Cookie or bearer header, both accepted. A Playwright script gets the cookie
 * for free; a raw HTTP client that would rather hold the token itself can.
 */
export function tokenFrom(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && /^Bearer /i.test(auth)) return auth.slice(7).trim() || null;
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === COOKIE) return rest.join("=") || null;
  }
  return null;
}

export async function currentRun(store: Store, req: Request): Promise<RunRow | null> {
  const token = tokenFrom(req);
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "r1") return null;
  const run = await store.runById(parts[1]!);
  if (!run || run.status !== "open") return null;
  return sameString(await hmac(run.secret, `pixe/token/1:${run.id}`), parts[2]!) ? run : null;
}

/* ------------------------------------------------------------------ */
/* The chained sequence                                                */
/* ------------------------------------------------------------------ */

/**
 * The difficulty band for chain position `idx`.
 *
 * A uniform draw over 1..999999 would put every puzzle in `tierFor`'s top tier
 * from the first one, which is both a brutal opening and a dead benchmark — the
 * most interesting signal on the chart is wall clock against chain position,
 * and that curve needs somewhere to start. So the band's ceiling widens
 * geometrically with position: positions 0-5 walk the generator's own tier
 * boundaries (1-3, 4-10, 11-25), then the ceiling grows ~35% per puzzle and
 * reaches the full ladder at about position 40.
 *
 * Widening rather than sliding, deliberately: the floor stays at 26 so a long
 * run keeps drawing from the whole space rather than marching off into a
 * corner of it, and the draw stays unpredictable because the band is public
 * but the HMAC that picks within it is not.
 */
export function bandFor(idx: number): { lo: number; hi: number } {
  if (idx <= 0) return { lo: 1, hi: 3 };
  if (idx <= 2) return { lo: 4, hi: 10 };
  if (idx <= 5) return { lo: 11, hi: 25 };
  const hi = Math.min(LADDER_MAX, Math.round(25 * Math.pow(1.35, idx - 5)));
  return { lo: 26, hi: Math.max(27, hi) };
}

/** Digest of an accepted grid. Canonicalised first, so it is a digest of the board rather than of the bytes some client happened to send. */
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
/* Renderable state                                                    */
/* ------------------------------------------------------------------ */

/**
 * What the browser is allowed to know about the open puzzle.
 *
 * Note what is absent: the seed, the scheme, the rules, the point value's
 * derivation, and `hueSet`. The old client re-derived every law from the seed
 * to drive the glow, and that is exactly what was extracted and batch-solved.
 * The palette renders all eight hues anyway, so withholding `hueSet` costs the
 * player nothing and stops the board announcing which colours it is made of.
 */
async function boardPayload(run: RunRow, issue: IssueRow): Promise<Record<string, unknown>> {
  const { puzzle } = dialectPuzzle(run.dialect, issue.puzzle_key);
  return {
    idx: issue.idx,
    key: issue.puzzle_key,
    title: puzzle.title,
    points: puzzle.points,
    grid: GRID,
    issuedAt: issue.issued_at,
    // A fresh attestation chain for this issue. Handing it out again after a
    // reload only rewinds the client's own tally, which is not an attack.
    receipt: await openReceipt(run.secret, run.id, issue.idx),
    nonce: await nonceFor(run.secret, run.id, issue.idx, 0, Date.now()),
    // The execution chain opens the same way and for the same reason: challenge
    // zero and a receipt for zero proofs. Neither leaks anything about the
    // board — the challenge is twelve cell indices derived from the run secret,
    // and the answer is the pixels the page has already drawn for itself.
    exec: await execChallenge(run.secret, run.id, issue.idx, 0),
    execReceipt: await openExecReceipt(run.secret, run.id, issue.idx),
  };
}

/**
 * The two feedback channels, computed server-side.
 *
 * `bad` is a 4096-cell mask run-length encoded with the ordinary grid codec —
 * `0` where a cell should flash, empty elsewhere — so the client decodes it
 * with `decodeGrid` and gets a few dozen bytes on the wire instead of an array
 * of four thousand integers.
 *
 * `RuleEval.progress` is deliberately not forwarded. Its `need` field is the
 * literal threshold of a counting law, and shipping that would put the rule
 * text back on the wire in numeric form.
 */
/**
 * The two feedback channels, in the shape `public/agents.txt` publishes.
 *
 * `badCells` is a plain index array rather than the run-length mask this used
 * to send. The mask was smaller in the worst case, but the worst case does not
 * happen: violations are a handful of cells, not a grid, so the array is
 * smaller in practice and readable without pulling the codec into a solver. It
 * cost a name too — the wire said `bad`/`hot` while the spec agents actually
 * read said `badCells`/`hotHues`, which is the kind of drift that turns into a
 * support thread rather than a bug report.
 */
function feedbackFor(a: Assessment): Record<string, unknown> {
  return {
    badCells: [...a.badCells],
    hotHues: [...a.hotHues],
    filled: a.filled,
    empty: a.empty,
    bonds: a.bonds,
    solved: a.solved,
  };
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

/*
 * `postRun` used to live here. Registration now belongs to `server/pairing.ts`,
 * because a run may not draw a puzzle until a human has vouched for its
 * harness, and that handler is the only one that can mint the device code. Two
 * registration paths would mean one of them could create an unpaired run.
 */

/** `GET /api/run/me` — who am I and how far along. */
export async function getRunMe(req: Request, _url: URL, deps: RunDeps): Promise<Response> {
  const run = await currentRun(deps.store, req);
  if (!run) return json({ run: null });
  const [solves, open] = await Promise.all([
    deps.store.runSolves(run.id),
    deps.store.openIssue(run.id),
  ]);
  return json({
    run: {
      runId: run.id,
      harness: run.harness,
      config: run.config,
      createdAt: run.created_at,
      status: run.status,
    },
    solved: solves.length,
    points: solves.reduce((s, r) => s + r.points, 0),
    bonds: solves.reduce((s, r) => s + r.bonds, 0),
    open: open ? { idx: open.idx, key: open.puzzle_key, issuedAt: open.issued_at } : null,
  });
}

/**
 * `POST /api/next` — close the open issue and issue the next puzzle.
 *
 * The clock for a puzzle starts when its row is written, and the row is written
 * before the board is derived, so `issued_at` always precedes the moment the
 * agent could first have seen anything about the board. There is no ordering of
 * requests that gets content out ahead of the timestamp.
 */
export async function postNext(req: Request, _url: URL, deps: RunDeps): Promise<Response> {
  const { store } = deps;
  const run = await currentRun(store, req);
  if (!run) return fail(401, "Register a run first: POST /api/run.");
  const now = Date.now();

  const open = await store.openIssue(run.id);
  if (open) {
    const held = now - open.issued_at;
    if (held < ABANDON_MIN_MS) {
      return json(
        {
          error: "You already have a puzzle. Finish it, or wait before abandoning it.",
          retryAfterMs: ABANDON_MIN_MS - held,
          idx: open.idx,
        },
        { status: 429, headers: { "retry-after": String(Math.ceil((ABANDON_MIN_MS - held) / 1000)) } },
      );
    }
    await store.closeIssue(run.id, open.idx, now, "abandoned");
  }

  const idx = await store.nextIdx(run.id);
  const key = await nextKey(store, run, idx);
  const issue = await store.insertIssue(run.id, idx, key, now);
  await store.touchRun(run.id, now);

  return json({ ...(await boardPayload(run, issue)), abandoned: open ? open.idx : null });
}

/** `GET /api/board` — the open puzzle's renderable state, and nothing else. */
export async function getBoard(req: Request, _url: URL, deps: RunDeps): Promise<Response> {
  const { store } = deps;
  const run = await currentRun(store, req);
  if (!run) return fail(401, "Register a run first: POST /api/run.");
  const issue = await store.openIssue(run.id);
  if (!issue) return fail(404, "No open puzzle. POST /api/next for one.");
  await store.bumpCalls(run.id, issue.idx);
  return json(await boardPayload(run, issue));
}

/**
 * `POST /api/attest` — attested event batch in, feedback out.
 *
 * These are one endpoint on purpose. Feedback is the entire teaching mechanism,
 * so it is the thing every client must call constantly — which makes it the
 * right place to hang attestation, rather than a side channel a scripted client
 * would simply never call. You cannot watch the board react without telling the
 * server what you did to it, and you cannot bank a solve without having watched
 * the board react.
 */
export async function postAttest(req: Request, _url: URL, deps: RunDeps): Promise<Response> {
  const { store } = deps;
  const run = await currentRun(store, req);
  if (!run) return fail(401, "Register a run first: POST /api/run.");
  const issue = await store.openIssue(run.id);
  if (!issue) return fail(404, "No open puzzle. POST /api/next for one.");

  await store.bumpCalls(run.id, issue.idx);
  // Every attest batch hands back the glow, so every one is a look at the
  // board. `/api/board` is not counted: asking for the board again only
  // repeats what the agent was already told.
  await store.bumpProbes(run.id, issue.idx);
  if ((await store.callCount(run.id, issue.idx)) > MAX_CALLS_PER_ISSUE) {
    return fail(429, "This puzzle has had its budget of round trips. Take it to /api/submit.");
  }

  const body = await readJson(req);
  if (!body) return fail(400, "Bad request");

  const now = Date.now();
  const v = await verifyAttest(run.secret, run.id, issue.idx, body, now);
  if (!v.ok) return fail(v.status, v.error);

  await store.touchRun(run.id, now);

  // Decoded before the response is assembled, because the execution check needs
  // it: the server re-derives the canvas bytes the page claims to have read back
  // from this exact grid. A `null` grid is an envelope flushed during a pause,
  // which makes the readback unverifiable rather than wrong.
  let grid: Grid | null = null;
  if (v.art !== undefined && v.art !== null) {
    grid = decodeGrid(v.art);
    if (!grid) return fail(400, "That canvas is not a canvas.");
  }

  // Never rejects. A proof that is absent, stale, or simply wrong advances the
  // chain and increments nothing; `gateExec` at submit is the only place any of
  // it is read, and even there it is observe-only. See `docs/EXEC-BINDING.md`.
  const ex = await verifyExecProof({
    secret: run.secret,
    runId: run.id,
    idx: issue.idx,
    receipt: body.execReceipt,
    proof: body.exec,
    grid,
    now,
  });

  const out: Record<string, unknown> = {
    idx: issue.idx,
    receipt: v.receipt,
    nonce: v.nonce,
    events: v.tally.events,
    accepted: v.tally.events,
    execReceipt: ex.receipt,
    exec: ex.challenge,
  };

  // Feedback is optional on the envelope: a client batching events during a
  // pause has nothing new to be told about.
  if (grid) out.feedback = feedbackFor(assessDialect(run.dialect, issue.puzzle_key, grid));
  return json(out);
}

function reported(v: unknown): number | null {
  return Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null;
}

function shareId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    b.toString(36).padStart(2, "0"),
  ).join("").slice(0, 12);
}

/**
 * `POST /api/submit` — bank the open issue.
 *
 * The client is trusted with pixels and with three numbers it declares about
 * itself. Everything that ranks anything — points, bonds, difficulty, wall
 * clock, call count, attested events — is computed here.
 */
export async function postSubmit(req: Request, _url: URL, deps: RunDeps): Promise<Response> {
  const { store } = deps;
  const run = await currentRun(store, req);
  if (!run) return fail(401, "Register a run first: POST /api/run.");
  const issue = await store.openIssue(run.id);
  if (!issue) return fail(404, "No open puzzle. POST /api/next for one.");
  await store.bumpCalls(run.id, issue.idx);

  const body = await readJson(req);
  if (!body) return fail(400, "Bad request");
  const grid = decodeGrid(body.art);
  if (!grid) return fail(400, "That canvas is not a canvas.");

  const now = Date.now();
  // The grid the server decoded, not one the client nominated. `readReceipt`
  // took the canvas from a `<receipt>!<grid>` suffix on the credential, which
  // let the two diverge: a client could bind the receipt to the board it really
  // painted and then bank a different `art`, since nothing compared the banked
  // grid to the attested one. Passing the decoded grid is what actually ties
  // the stroke history to the submission.
  const tally = await bindReceipt(run.secret, run.id, issue.idx, body.receipt, grid);
  if (!tally) return fail(400, "That attestation receipt is not ours.");
  const gate = gateSubmit(tally, now);
  if (gate) return fail(403, gate);

  /*
   * OBSERVE-ONLY, AND IT STAYS THAT WAY UNTIL SOMEBODY MEASURES IT.
   *
   * `gateExec` complains about an empty tally by design, so a live gate here
   * would refuse every client that has not been taught to send proofs — an
   * older page, a harness driving the JSON API, anything mid-rollout. That is
   * the entire population on day one. `docs/EXEC-BINDING.md` asks for the
   * complaint to be logged and watched first, and `exec-bind.test.ts` pins the
   * empty-tally complaint precisely so this cannot be flipped by accident.
   *
   * Turning it into a 403 needs one thing first: the rate at which it fires on
   * runs that are plainly honest, known to be zero. Not a hunch that it is.
   */
  const exTally = await readExecReceipt(run.secret, run.id, issue.idx, body.execReceipt);
  const exGate = exTally ? gateExec(exTally, now) : "No execution proof for this puzzle.";
  if (exGate) {
    console.warn(
      "exec-gate observe-only",
      JSON.stringify({
        run: run.id,
        idx: issue.idx,
        complaint: exGate,
        seq: exTally?.seq ?? null,
        proofs: exTally?.proofs ?? null,
        pixel: exTally?.pixel ?? null,
        style: exTally?.style ?? null,
        frames: exTally?.frames ?? null,
      }),
    );
  }

  const result = assessDialect(run.dialect, issue.puzzle_key, grid);
  if (!result.solved) {
    // 200, not 422. Submitting an unfinished grid is not an error — it is the
    // observation channel, and the only way to see the board react now that the
    // client cannot derive the laws itself. Probing is expected play, priced by
    // the clock and the per-issue call ceiling rather than forbidden. A 4xx here
    // would also make many HTTP clients throw on a move the protocol invites,
    // and `agents.txt` documents this shape. 422 stays reserved for a grid the
    // server could not decode at all.
    // A rejected submit taught the agent something, so it costs a probe. The
    // accepted one does not: nothing is learned from being told you are done,
    // and charging for it would make a perfect first-try solve look like a
    // guess rather than the best possible result.
    await store.bumpProbes(run.id, issue.idx);
    return json({
      accepted: false,
      idx: issue.idx,
      key: issue.puzzle_key,
      ...feedbackFor(result),
    });
  }

  // Idempotent by the same reasoning the old solve route used: the check and
  // the insert are not in one transaction, so two submissions racing each other
  // must not both bank, and a write that commits without answering must stay
  // retryable.
  const existing = await store.solveAt(run.id, issue.idx);
  if (existing) {
    // `accepted` on both banked branches, because a re-submission of a board
    // you already solved is still an accepted grid — it just pays nothing. The
    // field was missing here and on the branch below while `agents.txt`
    // documented it, so a solver branching on `accepted` saw a rejection every
    // time it succeeded.
    return json({
      accepted: true,
      alreadySolved: true, idx: issue.idx, points: 0, bonds: existing.bonds,
      shareId: existing.share_id,
    });
  }

  const art = encodeGrid(grid);
  const row: NewRunSolve = {
    run_id: run.id,
    idx: issue.idx,
    puzzle_key: issue.puzzle_key,
    points: result.puzzle.points,
    bonds: result.bonds,
    difficulty: Math.round(result.puzzle.difficulty),
    wall_ms: Math.max(0, now - issue.issued_at),
    api_calls: await store.callCount(run.id, issue.idx),
    probes: await store.probeCount(run.id, issue.idx),
    events: tally.events,
    tokens_in: reported(body.tokensIn),
    tokens_out: reported(body.tokensOut),
    cost_micro: reported(body.costMicro),
    art,
    share_id: shareId(),
    created_at: now,
  };
  const solve = await store.insertRunSolve(row);
  await store.closeIssue(run.id, issue.idx, now, "solved");
  await store.touchRun(run.id, now);

  return json({
    accepted: true,
    alreadySolved: false,
    idx: solve.idx,
    key: solve.puzzle_key,
    points: solve.points,
    bonds: solve.bonds,
    parBonds: result.puzzle.parBonds,
    wallMs: solve.wall_ms,
    apiCalls: solve.api_calls,
    probes: solve.probes,
    events: solve.events,
    shareId: solve.share_id,
    // The post-solve reveal. Safe now and only now: this board is banked, and
    // the next key is unreachable without the run secret regardless of what the
    // agent learns about this one.
    reveal: { title: result.puzzle.title, scheme: result.puzzle.scheme, rules: result.puzzle.rules },
  });
}

/**
 * Every run-scoped route, for the lead agent to hang off `handleApi`. Returns
 * `null` for a path this module does not own, so the caller can fall through.
 */
export async function handleRunApi(req: Request, url: URL, deps: RunDeps): Promise<Response | null> {
  const p = url.pathname;
  const post = req.method === "POST";

  if (p === "/api/run/me") return getRunMe(req, url, deps);
  if (p === "/api/next") return post ? postNext(req, url, deps) : fail(405, "Method not allowed");
  if (p === "/api/board") return getBoard(req, url, deps);
  if (p === "/api/attest") return post ? postAttest(req, url, deps) : fail(405, "Method not allowed");
  if (p === "/api/submit") return post ? postSubmit(req, url, deps) : fail(405, "Method not allowed");
  return null;
}
