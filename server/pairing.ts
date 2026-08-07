/**
 * Device-code pairing: a human vouches for a run before it may draw a board.
 *
 * The benchmark showcases *harnesses* — Claude Code, Codex, Devin, Cursor — and
 * the harness is the one claim the person at the keyboard both knows for
 * certain and actively wants stated correctly: "this is Claude Code driving it"
 * is the claim they came to make. So the harness is collected from a human and
 * never from the agent.
 *
 * The human is also asked for `config` — free prose about the setup, "Opus 5"
 * or "opus planner + haiku subagents". It is written down and displayed and
 * that is all: it is never ranked, sorted or aggregated, because a harness with
 * subagents may be driving several models at once and a sortable column of
 * those strings would read as a model leaderboard this benchmark cannot
 * honestly produce.
 *
 * This costs the protocol its "nothing to arrange out of band" property, which
 * was a real and deliberate feature. That trade is accepted rather than hidden:
 * every run is now vouched for by someone, and the docs say plainly that an
 * agent cannot start alone.
 *
 * The shape is RFC 8628's device authorization grant, and deliberately not a
 * localhost callback. Agents run in containers, CI and cloud sandboxes where
 * the human's browser cannot reach the agent's loopback interface. A short code
 * the human carries to a hosted page is the only shape that works everywhere,
 * and it is the flow people already know from signing a television into a
 * streaming service.
 *
 * The reusable operator key is what keeps the cost to one human step per
 * person rather than one per run: the first run needs somebody, every run after
 * it does not.
 */

import { newDialectSalt } from "../shared/dialect";
import { PROTOCOL_VERSION, label, parseRegisterRun } from "../shared/protocol";
import { b64url, hmac, sameString, sha256Hex } from "./attest";
import { mintToken, runCookie, tokenFrom, type RunDeps } from "./runs";
import { PAIR_CODE_TTL_MS, type OperatorRow, type RunRow, type Store } from "./store";

export type PairDeps = RunDeps;

const MAX_BODY = 16 * 1024;

/** Same budget `runs.ts` gave run creation, so routing `/api/run` here does not quietly change it. */
const RUN_WINDOW_MS = 60 * 60 * 1000;
const MAX_RUNS_PER_IP = 20;

/**
 * A code a human retypes has to be short, which makes it guessable by
 * construction — so the budget for guessing it is the security property, not
 * the code's length. Twelve tries per quarter hour against 31^8 codes, all of
 * which expire in fifteen minutes, is not a search anyone finishes.
 */
const CLAIM_WINDOW_MS = 15 * 60 * 1000;
const MAX_CLAIMS_PER_IP = 12;

/**
 * Polling is the agent's only way to learn that its human is done, so it must
 * stay cheap — but an agent that ignores `pollIntervalMs` and spins is a load
 * problem. Keyed by run rather than by IP: the run is the thing being polled,
 * and one machine legitimately holding several pending runs should not throttle
 * itself.
 */
const POLL_INTERVAL_MS = 3_000;
const POLL_WINDOW_MS = 60_000;
const MAX_POLLS_PER_WINDOW = 40;

/**
 * No `0/O` and no `1/I/L`: every remaining glyph survives being read off one
 * screen and typed into another. Grouped `XXXX-XXXX` for the same reason.
 */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LEN = 8;

/** The largest multiple of the alphabet that fits in a byte; above it we resample. */
const CODE_BYTE_LIMIT = CODE_ALPHABET.length * Math.floor(256 / CODE_ALPHABET.length);

const OP_KEY_PREFIX = "pxop_";
const OP_KEY_RE = /^pxop_[A-Za-z0-9_-]{16,86}$/;

/* ------------------------------------------------------------------ */
/* Plumbing                                                            */
/* ------------------------------------------------------------------ */

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

const fail = (status: number, error: string, code?: string) =>
  json(code ? { error, code } : { error }, { status });

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return null;
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const randB64 = (bytes: number) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

const randHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/**
 * `display`, `harness`, `config` and `contact` are typed by a human and
 * rendered on a public page, so they are flattened by the shared `label` — no
 * control characters, no zero-width tricks, whitespace collapsed, length
 * capped. Importing it rather than restating the rule is what keeps a second,
 * subtly different sanitiser from existing.
 *
 * Returns `false` for "given but unusable", which is a different answer from
 * "not given" and has to stay tellable apart: one is a 400, the other is a null
 * column.
 */
function optionalLabel(v: unknown): string | null | false {
  if (v === undefined || v === null || v === "") return null;
  return label(v) ?? false;
}

/* ------------------------------------------------------------------ */
/* Codes and keys                                                      */
/* ------------------------------------------------------------------ */

export function newUserCode(): string {
  const out: string[] = [];
  while (out.length < CODE_LEN) {
    for (const byte of crypto.getRandomValues(new Uint8Array(CODE_LEN))) {
      if (byte >= CODE_BYTE_LIMIT) continue;
      out.push(CODE_ALPHABET[byte % CODE_ALPHABET.length]!);
      if (out.length === CODE_LEN) break;
    }
  }
  return out.join("");
}

/**
 * What the human typed, reduced to what the database stores. Case and grouping
 * are presentation; a code pasted as `abcd efgh` is the same code. A glyph
 * outside the alphabet cannot be repaired — `O` could have been `Q` or `D` —
 * so it fails like any other wrong code rather than being guessed at.
 */
export function canonicalCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 32) return null;
  const cleaned = raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (cleaned.length !== CODE_LEN) return null;
  for (const ch of cleaned) if (!CODE_ALPHABET.includes(ch)) return null;
  return cleaned;
}

export const formatCode = (canonical: string) => `${canonical.slice(0, 4)}-${canonical.slice(4)}`;

const newOperatorKey = () => OP_KEY_PREFIX + randB64(24);

/** Only the hash is stored: a database read must not be able to mint runs under someone else's harness. */
export const operatorKeyHash = (key: string) => sha256Hex(`pixe/opkey/1:${key}`);

/** Bearer on `/api/run` is an operator key; a run token (`r1.…`) fails the shape and is ignored. */
function operatorKeyFrom(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth || !/^Bearer /i.test(auth)) return null;
  const value = auth.slice(7).trim();
  return OP_KEY_RE.test(value) ? value : null;
}

/**
 * Where to send the human.
 *
 * `url.origin` is the API's origin, which is the right answer in production —
 * the Worker serves the site and the API from one hostname. It is the wrong
 * answer in development, where the API is on :3001 and the page the human needs
 * is on Vite's :5173, so the code would arrive with a URL that 404s. Anything
 * fronted by a proxy has the same shape of problem, hence the override.
 */
function verificationOrigin(url: URL): string {
  const override = typeof process !== "undefined" ? process.env?.PIXE_PUBLIC_ORIGIN : undefined;
  return override || url.origin;
}

/**
 * The same self-validating token check `runs.currentRun` does, for the one
 * status it refuses. A pending run holds a real token — it has to, or it could
 * not poll — but `currentRun` must keep rejecting it, because that rejection is
 * what stops an unvouched run from drawing a board.
 */
async function pendingRunFrom(store: Store, req: Request): Promise<RunRow | null> {
  const token = tokenFrom(req);
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "r1") return null;
  const run = await store.runById(parts[1]!);
  if (!run || run.status !== "pending") return null;
  return sameString(await hmac(run.secret, `pixe/token/1:${run.id}`), parts[2]!) ? run : null;
}

const dialectLabel = async (secret: string) =>
  `d-${(await hmac(secret, "pixe/dialect-label/1")).slice(0, 8)}`;

function pairingPayload(url: URL, code: string, expiresAt: number) {
  const userCode = formatCode(code);
  const verificationUri = new URL("/for-humans", verificationOrigin(url)).toString();
  return {
    userCode,
    verificationUri,
    // RFC 8628's `verification_uri_complete`: one link the human can be handed,
    // for the common case where the agent can put a URL in front of them.
    verificationUriComplete: `${verificationUri}?code=${userCode}`,
    pollIntervalMs: POLL_INTERVAL_MS,
    expiresAt,
  };
}

/** A run's code is minted with the run, so its deadline is the run's own creation plus the TTL. */
const codeExpiryOf = (run: RunRow) => run.created_at + PAIR_CODE_TTL_MS;

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

/**
 * `POST /api/run` — register a run, paired or pending.
 *
 * With an operator key the run is born `open` wearing that operator's harness
 * and config. Without one it is born `pending`: it has a token, it can poll,
 * and it cannot draw a puzzle until a human has typed its code into
 * `/for-humans`.
 *
 * The body declares nothing at all — no name for the agent, no model, and a
 * `harness` in it is refused rather than honoured. Identity is the human's
 * claim or it is nothing, which is the entire reason pairing exists.
 */
export async function postRun(req: Request, url: URL, deps: PairDeps): Promise<Response> {
  const { store, ip, secure } = deps;
  const now = Date.now();

  // Database-backed rather than a `Map`, for the reason the login throttle was:
  // on Workers requests land in whichever isolate is warm, so an in-memory
  // counter does not throttle, it merely appears to.
  if ((await store.attemptCount(`run:${ip}`, now)) >= MAX_RUNS_PER_IP) {
    return fail(429, "Too many runs registered from here. Wait a while.", "rate_limited");
  }
  await store.noteAttempt(`run:${ip}`, now, RUN_WINDOW_MS);

  const parsed = parseRegisterRun((await readJson(req)) ?? {});
  if (!parsed.ok) return fail(400, parsed.error, parsed.code);

  const presented = operatorKeyFrom(req);
  let operator: OperatorRow | null = null;
  if (presented) {
    operator = await store.operatorByKeyHash(await operatorKeyHash(presented));
    if (!operator) {
      return fail(401, "That operator key is not one of ours. Pair again to get a new one.", "no_operator");
    }
  }

  const secret = randHex(32);
  const run = await store.createRun({
    id: randB64(12),
    secret,
    // Copied onto the run rather than joined at read time: an operator who
    // later pairs a second agent under a different setup must not retroactively
    // relabel the runs the first one already banked.
    harness: operator ? operator.harness : null,
    config: operator ? operator.config : null,
    operator_id: operator ? operator.id : null,
    dialect: newDialectSalt(),
    created_at: now,
    last_at: now,
    status: operator ? "open" : "pending",
  });

  const token = await mintToken(run);
  const base = {
    protocol: PROTOCOL_VERSION,
    runId: run.id,
    runToken: token,
    // NOT the dialect salt. A client holding the salt can re-derive every law in
    // the run. This is a stable public name for the dialect, so two runs can be
    // told apart in the benchmark table without either being handed the other's
    // board.
    dialect: await dialectLabel(secret),
    harness: run.harness,
    config: run.config,
    status: run.status,
  };
  const headers = { "set-cookie": runCookie(token, secure) };

  if (operator) {
    await store.touchOperator(operator.id, now);
    return json(
      {
        ...base,
        operator: { display: operator.display, harness: operator.harness, config: operator.config },
      },
      { headers },
    );
  }

  const expiresAt = now + PAIR_CODE_TTL_MS;
  const code = await mintPairCode(store, run.id, now, expiresAt);
  if (!code) return fail(503, "Could not start pairing. Try registering again.", "server_error");

  return json(
    {
      ...base,
      ...pairingPayload(url, code, expiresAt),
      instructions:
        "Ask the human running you to open the verification URI and enter this code. " +
        "They will be asked which harness you are running under, and that answer — not " +
        "anything you send — is the identity the benchmark publishes. Poll GET /api/run/me " +
        "until status is 'open'; you cannot be issued a puzzle before then.",
    },
    { headers },
  );
}

/**
 * Codes are drawn from 31^8, so a collision needs an unlucky day rather than a
 * busy one — but the column is a primary key, and a run that fails to get a
 * code is a run its human can never rescue. Retrying is three lines.
 */
async function mintPairCode(
  store: Store,
  runId: string,
  now: number,
  expiresAt: number,
): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newUserCode();
    try {
      await store.createPairCode({
        user_code: code,
        run_id: runId,
        created_at: now,
        expires_at: expiresAt,
        claimed_at: null,
        operator_id: null,
      });
      return code;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * `GET /api/run/me` for a run that is still pending, and `null` for anything
 * else so the caller falls through to the ordinary handler.
 *
 * A paired run needs no special case: pairing lifts it to `open`, at which point
 * `runs.getRunMe` answers and the `pairing` block simply stops appearing. That
 * absence is the signal an agent polls for.
 */
export async function getRunMe(req: Request, url: URL, deps: PairDeps): Promise<Response | null> {
  const { store } = deps;
  const run = await pendingRunFrom(store, req);
  if (!run) return null;

  const now = Date.now();
  if ((await store.attemptCount(`poll:${run.id}`, now)) >= MAX_POLLS_PER_WINDOW) {
    return json(
      {
        error: `Slow down. Poll every ${POLL_INTERVAL_MS}ms, not faster.`,
        code: "rate_limited",
        pollIntervalMs: POLL_INTERVAL_MS,
      },
      { status: 429, headers: { "retry-after": String(Math.ceil(POLL_INTERVAL_MS / 1000)) } },
    );
  }
  await store.noteAttempt(`poll:${run.id}`, now, POLL_WINDOW_MS);

  const expiresAt = codeExpiryOf(run);
  return json({
    run: {
      runId: run.id,
      harness: run.harness,
      config: run.config,
      createdAt: run.created_at,
      status: run.status,
    },
    solved: 0,
    points: 0,
    bonds: 0,
    open: null,
    // The code itself is not echoed here. The agent was handed it once and is
    // the party responsible for showing it to a human; repeating it on an
    // endpoint that gets called every three seconds only widens where it can be
    // read from, and an agent that has lost it can register a new run.
    pairing: {
      expired: expiresAt <= now,
      verificationUri: new URL("/for-humans", verificationOrigin(url)).toString(),
      pollIntervalMs: POLL_INTERVAL_MS,
      expiresAt,
      message:
        expiresAt <= now
          ? "That pairing code expired. POST /api/run again for a fresh one."
          : "Waiting for a human to enter the code.",
    },
  });
}

/**
 * `POST /api/pair/claim` — the human's half, and the only write in the system a
 * person makes.
 *
 * Every way of failing to name a live code answers identically. Distinguishing
 * "no such code" from "expired" from "already used" would turn this endpoint
 * into a free oracle over an eight-character space, and the honest human who
 * needs the distinction has an agent sitting there able to hand them a new code.
 */
export async function postPairClaim(req: Request, _url: URL, deps: PairDeps): Promise<Response> {
  const { store, ip } = deps;
  const now = Date.now();

  if ((await store.attemptCount(`pair:${ip}`, now)) >= MAX_CLAIMS_PER_IP) {
    return fail(429, "Too many pairing attempts from here. Try again in a few minutes.", "rate_limited");
  }
  await store.noteAttempt(`pair:${ip}`, now, CLAIM_WINDOW_MS);

  const body = await readJson(req);
  if (!body) return fail(400, "Send a JSON object.", "bad_request");

  const display = label(body.display);
  if (!display) return fail(400, "Give a display name of 1-48 printable characters.", "bad_request");
  const harness = label(body.harness);
  if (!harness) {
    return fail(400, "Name the harness this agent is running under, 1-48 printable characters.", "bad_request");
  }
  // Prose about the setup, and prose is all it is: stored, displayed, and never
  // ranked, sorted or aggregated anywhere.
  const config = optionalLabel(body.config);
  if (config === false) {
    return fail(400, "That setup note is not usable. Leave it blank if unsure.", "bad_request");
  }
  const contact = optionalLabel(body.contact);
  if (contact === false) return fail(400, "That contact is not usable. Leave it blank.", "bad_request");

  const wrongCode = () =>
    fail(
      400,
      "That code is expired, already used, or mistyped. Ask your agent for a fresh one.",
      "bad_pair_code",
    );

  const canonical = canonicalCode(body.userCode ?? body.code);
  if (!canonical) return wrongCode();

  const code = await store.pairCode(canonical);
  if (!code || code.claimed_at !== null || code.expires_at <= now) return wrongCode();
  const run = await store.runById(code.run_id);
  if (!run || run.status !== "pending") return wrongCode();

  const operatorKey = newOperatorKey();
  const operator = await store.createOperator({
    id: randB64(12),
    key_hash: await operatorKeyHash(operatorKey),
    display,
    harness,
    config,
    contact,
    created_at: now,
    last_at: now,
  });

  // `claimPairCode` is guarded on `claimed_at IS NULL`, so two humans racing one
  // code cannot both bind it — the loser's update matches no row. Reading the
  // row back is how the loser finds out. It leaves an operator nobody owns,
  // which costs one dead row and is far better than a check-then-write that
  // hands the same run to two people.
  await store.claimPairCode(canonical, operator.id, now);
  const claimed = await store.pairCode(canonical);
  if (!claimed || claimed.operator_id !== operator.id) return wrongCode();

  await store.attachOperator(run.id, operator.id, harness, config, now);
  const attached = await store.runById(run.id);
  if (!attached || attached.operator_id !== operator.id) return wrongCode();

  // A pairing that worked is evidence this address is a person, not a search.
  // Without this a shared office address would lock its twelfth colleague out.
  await store.clearAttempts(`pair:${ip}`);

  return json({
    ok: true,
    // The only time this string exists outside the human's clipboard. Nothing
    // else in the API returns it, and the row holds a hash, so a lost key is
    // replaced by pairing again rather than recovered.
    operatorKey,
    operator: { display, harness, config, contact },
    run: {
      runId: attached.id,
      harness: attached.harness,
      config: attached.config,
      status: attached.status,
    },
  });
}

/**
 * Every route this module owns. Returns `null` for a path it does not — and,
 * for `/api/run/me`, for a run that is past pairing — so the caller falls
 * through to `handleRunApi`.
 */
export async function handlePairApi(req: Request, url: URL, deps: PairDeps): Promise<Response | null> {
  const p = url.pathname;
  const post = req.method === "POST";

  if (p === "/api/run") return post ? postRun(req, url, deps) : null;
  if (p === "/api/pair/claim") {
    return post ? postPairClaim(req, url, deps) : fail(405, "Method not allowed");
  }
  if (p === "/api/run/me" && req.method === "GET") return getRunMe(req, url, deps);
  return null;
}
