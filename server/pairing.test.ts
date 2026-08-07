/**
 * Pairing is the one place a human touches this system, and it is guarded by a
 * code short enough to read aloud. So the tests that matter here are the ones
 * about what a code cannot do: outlive its window, be spent twice, be guessed
 * at leisure, or let a run that nobody vouched for draw a board.
 */

import { describe, expect, test } from "bun:test";
import { sqliteStore } from "./store-sqlite";
import { PAIR_CODE_TTL_MS, type Store } from "./store";
import { getBoard, postNext } from "./runs";
import {
  canonicalCode,
  getRunMe,
  handlePairApi,
  newUserCode,
  postPairClaim,
  postRun,
} from "./pairing";

const ORIGIN = "http://pixe.test";

const fresh = (): Store => sqliteStore(":memory:");
const deps = (store: Store, ip = "10.0.0.1") => ({ store, ip, secure: false });
const at = (path: string) => new URL(ORIGIN + path);

function post(path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(ORIGIN + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(ORIGIN + path, { headers });

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

interface Registered {
  runId: string;
  runToken: string;
  status: string;
  harness: string | null;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  pollIntervalMs?: number;
  expiresAt?: number;
  operator?: { display: string; harness: string };
}

async function register(store: Store, ip: string, key?: string): Promise<Registered> {
  const res = await postRun(
    post("/api/run", {}, key ? bearer(key) : {}),
    at("/api/run"),
    deps(store, ip),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Registered;
}

async function claim(
  store: Store,
  ip: string,
  userCode: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await postPairClaim(
    post("/api/pair/claim", { userCode, display: "Ada", harness: "Claude Code", ...extra }),
    at("/api/pair/claim"),
    deps(store, ip),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("user codes", () => {
  test("carry no glyph a human can misread", () => {
    for (let i = 0; i < 200; i++) {
      const code = newUserCode();
      expect(code).toHaveLength(8);
      expect(code).toMatch(/^[2-9A-HJ-KM-NP-Z]{8}$/);
      expect(code).not.toMatch(/[01OIL]/);
    }
  });

  test("read back the way a human types them", () => {
    expect(canonicalCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(canonicalCode(" ABCD EFGH ")).toBe("ABCDEFGH");
    // Excluded glyphs cannot be repaired — `O` could have been Q or D — so they
    // fail like any other wrong code rather than being guessed at.
    expect(canonicalCode("ABCDEFGO")).toBeNull();
    expect(canonicalCode("ABCDEFG")).toBeNull();
    expect(canonicalCode(42)).toBeNull();
  });
});

describe("registration", () => {
  test("an unpaired run is pending and carries everything its human needs", async () => {
    const store = fresh();
    const reg = await register(store, "10.1.0.1");

    expect(reg.status).toBe("pending");
    expect(reg.harness).toBeNull();
    expect(reg.userCode).toMatch(/^[2-9A-HJ-KM-NP-Z]{4}-[2-9A-HJ-KM-NP-Z]{4}$/);
    expect(reg.verificationUri).toBe(`${ORIGIN}/for-humans`);
    expect(reg.verificationUriComplete).toBe(`${ORIGIN}/for-humans?code=${reg.userCode}`);
    expect(reg.pollIntervalMs).toBeGreaterThan(0);
    expect(reg.expiresAt).toBeGreaterThan(Date.now());
    expect(reg.expiresAt! - Date.now()).toBeLessThanOrEqual(PAIR_CODE_TTL_MS);

    const row = await store.runById(reg.runId);
    expect(row?.status).toBe("pending");
    expect(row?.operator_id).toBeNull();
  });

  test("a pending run cannot draw a puzzle, however it asks", async () => {
    const store = fresh();
    const reg = await register(store, "10.1.0.2");

    for (const res of [
      await postNext(post("/api/next", {}, bearer(reg.runToken)), at("/api/next"), deps(store)),
      await getBoard(get("/api/board", bearer(reg.runToken)), at("/api/board"), deps(store)),
      await postNext(
        post("/api/next", {}, { cookie: `pixe_run=${reg.runToken}` }),
        at("/api/next"),
        deps(store),
      ),
    ]) {
      expect(res.status).toBe(401);
    }
    expect(await store.openIssue(reg.runId)).toBeNull();
  });

  test("the harness on the body is ignored — it is the human's claim or nothing", async () => {
    const store = fresh();
    const res = await postRun(
      post("/api/run", { harness: "definitely-real-harness" }),
      at("/api/run"),
      deps(store, "10.1.0.3"),
    );
    const body = (await res.json()) as Registered;
    expect(body.harness).toBeNull();
    expect((await store.runById(body.runId))?.harness).toBeNull();
  });

  test("registration is throttled per address", async () => {
    const store = fresh();
    let last = 200;
    for (let i = 0; i < 25 && last === 200; i++) {
      const res = await postRun(post("/api/run", {}), at("/api/run"), deps(store, "10.1.0.4"));
      last = res.status;
    }
    expect(last).toBe(429);
  });
});

describe("claiming", () => {
  test("pairing lifts the run, records the human's harness, and pays out a key once", async () => {
    const store = fresh();
    const reg = await register(store, "10.2.0.1");
    const { status, body } = await claim(store, "10.2.0.1", reg.userCode!, {
      model: "claude-opus-5",
      contact: "ada@example.com",
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const key = body.operatorKey as string;
    expect(key).toMatch(/^pxop_[A-Za-z0-9_-]{16,}$/);

    const run = await store.runById(reg.runId);
    expect(run?.status).toBe("open");
    expect(run?.harness).toBe("Claude Code");
    expect(run?.operator_id).toBeTruthy();

    // The row keeps a hash, never the key.
    const operator = await store.operatorById(run!.operator_id!);
    expect(operator?.key_hash).not.toContain(key);
    expect(operator?.display).toBe("Ada");
    expect(operator?.contact).toBe("ada@example.com");
  });

  test("a paired run can finally draw a board", async () => {
    const store = fresh();
    const reg = await register(store, "10.2.0.2");
    await claim(store, "10.2.0.2", reg.userCode!);

    const res = await postNext(post("/api/next", {}, bearer(reg.runToken)), at("/api/next"), deps(store));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { idx: number }).idx).toBe(0);
  });

  test("a code is spent once", async () => {
    const store = fresh();
    const reg = await register(store, "10.2.0.3");
    expect((await claim(store, "10.2.0.3", reg.userCode!)).status).toBe(200);

    const second = await claim(store, "10.2.0.3", reg.userCode!);
    expect(second.status).toBe(400);
    expect(second.body.operatorKey).toBeUndefined();
    // The second human did not overwrite the first one's operator.
    const run = await store.runById(reg.runId);
    const operators = await store.operatorById(run!.operator_id!);
    expect(operators?.display).toBe("Ada");
  });

  test("a code stops working when its window closes", async () => {
    const store = fresh();
    const now = Date.now();
    // Built through the store rather than by waiting fifteen minutes; this is
    // the same row `/api/run` writes, with its deadline already behind us.
    await store.createRun({
      id: "expired-run", secret: "s", harness: null, config: null,
      operator_id: null, dialect: "d", created_at: now - PAIR_CODE_TTL_MS - 1,
      last_at: now, status: "pending",
    });
    const code = newUserCode();
    await store.createPairCode({
      user_code: code, run_id: "expired-run", created_at: now - PAIR_CODE_TTL_MS - 1,
      expires_at: now - 1, claimed_at: null, operator_id: null,
    });

    const res = await claim(store, "10.2.0.4", code);
    expect(res.status).toBe(400);
    expect((await store.runById("expired-run"))?.status).toBe("pending");
  });

  test("every wrong code fails identically, so the endpoint is no oracle", async () => {
    const store = fresh();
    const now = Date.now();

    const live = await register(store, "10.2.0.5");
    await claim(store, "10.2.0.5", live.userCode!);

    await store.createRun({
      id: "stale-run", secret: "s", harness: null, config: null,
      operator_id: null, dialect: "d", created_at: now, last_at: now, status: "pending",
    });
    const expired = newUserCode();
    await store.createPairCode({
      user_code: expired, run_id: "stale-run", created_at: now,
      expires_at: now - 1, claimed_at: null, operator_id: null,
    });

    const answers = [
      await claim(store, "10.2.0.6", "MNPQ-RSTU"), // never existed
      await claim(store, "10.2.0.7", expired), // real, expired
      await claim(store, "10.2.0.8", live.userCode!), // real, already spent
      await claim(store, "10.2.0.9", "not a code"), // malformed
    ];
    for (const a of answers) {
      expect(a.status).toBe(answers[0]!.status);
      expect(a.body).toEqual(answers[0]!.body);
    }
  });

  test("guessing is throttled hard per address", async () => {
    const store = fresh();
    let attempts = 0;
    let status = 400;
    while (status !== 429 && attempts < 60) {
      status = (await claim(store, "10.2.0.10", "MNPQ-RSTU")).status;
      attempts++;
    }
    expect(status).toBe(429);
    expect(attempts).toBeLessThanOrEqual(20);
  });

  test("the form is validated before anything is written", async () => {
    const store = fresh();
    const reg = await register(store, "10.2.0.11");

    const noHarness = await postPairClaim(
      post("/api/pair/claim", { userCode: reg.userCode, display: "Ada" }),
      at("/api/pair/claim"),
      deps(store, "10.2.0.11"),
    );
    expect(noHarness.status).toBe(400);

    // Control and zero-width characters are flattened rather than stored, since
    // both fields render on a public page.
    const dirty = await claim(store, "10.2.0.11", reg.userCode!, {
      display: "Ada ​  Lovelace\n",
      harness: "Claude\tCode",
    });
    expect(dirty.status).toBe(200);
    const run = await store.runById(reg.runId);
    const operator = await store.operatorById(run!.operator_id!);
    expect(operator?.display).toBe("Ada Lovelace");
    expect(operator?.harness).toBe("Claude Code");
    expect(run?.status).toBe("open");
  });

  // Config is prose about the setup and is optional, but a human who bothered
  // to type it has to see it land on the run — it is displayed under the
  // harness on the public table, and a null there reads as "said nothing".
  test("the setup note the human typed reaches the run row", async () => {
    const store = fresh();
    const reg = await register(store, "10.2.0.12");
    const res = await claim(store, "10.2.0.12", reg.userCode!, {
      config: "opus planner + haiku subagents",
    });
    expect(res.status).toBe(200);

    const run = await store.runById(reg.runId);
    expect(run?.config).toBe("opus planner + haiku subagents");
    const operator = await store.operatorById(run!.operator_id!);
    expect(operator?.config).toBe("opus planner + haiku subagents");
  });

  test("no setup note is a null, not an empty string", async () => {
    const store = fresh();
    const reg = await register(store, "10.2.0.13");
    expect((await claim(store, "10.2.0.13", reg.userCode!, { config: "" })).status).toBe(200);
    expect((await store.runById(reg.runId))?.config).toBe(null);
  });
});

describe("the operator key", () => {
  test("pairs later runs with no human step", async () => {
    const store = fresh();
    const first = await register(store, "10.3.0.1");
    const paired = await claim(store, "10.3.0.1", first.userCode!);
    const key = paired.body.operatorKey as string;

    const second = await register(store, "10.3.0.1", key);
    expect(second.status).toBe("open");
    expect(second.harness).toBe("Claude Code");
    expect(second.userCode).toBeUndefined();
    expect(second.operator?.display).toBe("Ada");
    expect((await store.runById(second.runId))?.operator_id).toBeTruthy();

    const res = await postNext(post("/api/next", {}, bearer(second.runToken)), at("/api/next"), deps(store));
    expect(res.status).toBe(200);
  });

  test("is never echoed a second time", async () => {
    const store = fresh();
    const first = await register(store, "10.3.0.2");
    const paired = await claim(store, "10.3.0.2", first.userCode!);
    const key = paired.body.operatorKey as string;

    const again = await postRun(
      post("/api/run", {}, bearer(key)),
      at("/api/run"),
      deps(store, "10.3.0.2"),
    );
    const againText = await again.text();
    expect(againText).not.toContain(key);

    const pending = await register(store, "10.3.0.3");
    const me = await handlePairApi(
      get("/api/run/me", bearer(pending.runToken)),
      at("/api/run/me"),
      deps(store, "10.3.0.3"),
    );
    expect(await me!.text()).not.toContain(key);
  });

  test("an unknown key is refused rather than silently ignored", async () => {
    const store = fresh();
    const res = await postRun(
      post("/api/run", {}, bearer("pxop_" + "z".repeat(32))),
      at("/api/run"),
      deps(store, "10.3.0.4"),
    );
    expect(res.status).toBe(401);
  });

  test("a run token in the bearer slot is not mistaken for one", async () => {
    const store = fresh();
    const first = await register(store, "10.3.0.5");
    const second = await register(store, "10.3.0.5", first.runToken);
    expect(second.status).toBe("pending");
  });
});

describe("polling", () => {
  test("reports pending, then steps aside once the human is done", async () => {
    const store = fresh();
    const reg = await register(store, "10.4.0.1");

    const res = await getRunMe(get("/api/run/me", bearer(reg.runToken)), at("/api/run/me"), deps(store));
    const body = (await res!.json()) as {
      run: { status: string };
      pairing: { expired: boolean; verificationUri: string; pollIntervalMs: number };
    };
    expect(body.run.status).toBe("pending");
    expect(body.pairing.expired).toBe(false);
    expect(body.pairing.verificationUri).toBe(`${ORIGIN}/for-humans`);
    expect(body.pairing.pollIntervalMs).toBeGreaterThan(0);

    await claim(store, "10.4.0.1", reg.userCode!);
    // Null, so the router falls through to the ordinary run handler. The
    // `pairing` block disappearing is the signal an agent polls for.
    expect(
      await getRunMe(get("/api/run/me", bearer(reg.runToken)), at("/api/run/me"), deps(store)),
    ).toBeNull();
  });

  test("an agent that ignores pollIntervalMs is slowed down", async () => {
    const store = fresh();
    const reg = await register(store, "10.4.0.2");
    let status = 200;
    let calls = 0;
    while (status === 200 && calls < 200) {
      const res = await getRunMe(get("/api/run/me", bearer(reg.runToken)), at("/api/run/me"), deps(store));
      status = res!.status;
      calls++;
    }
    expect(status).toBe(429);
  });

  test("someone else's token does not answer for this run", async () => {
    const store = fresh();
    const reg = await register(store, "10.4.0.3");
    const forged = `r1.${reg.runId}.${"a".repeat(64)}`;
    expect(
      await getRunMe(get("/api/run/me", bearer(forged)), at("/api/run/me"), deps(store)),
    ).toBeNull();
  });
});
