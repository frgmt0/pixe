import type { Store, UserRow } from "./store";

const COOKIE = "pixe_sid";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const NAME_RE = /^[a-zA-Z0-9_.-]{2,20}$/;
export const MIN_PASSWORD = 6;
const MAX_PASSWORD = 200;

export function validateCredentials(name: unknown, password: unknown): string | null {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    return "Names are 2-20 characters: letters, numbers, and . _ - only.";
  }
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    return `Password needs at least ${MIN_PASSWORD} characters.`;
  }
  if (password.length > MAX_PASSWORD) return "That password is comically long.";
  return null;
}

/* ------------------------------------------------------------------ */
/* Password hashing                                                    */
/* ------------------------------------------------------------------ */

/**
 * PBKDF2-HMAC-SHA256 over Web Crypto, in place of Bun's argon2id.
 *
 * Not a preference — argon2 is memory-hard and therefore the better choice,
 * but the Workers runtime exposes no such primitive and cannot load a native
 * one. `crypto.subtle` is the only key-derivation available there, and it is
 * present in Bun too, so this is one implementation rather than an adapter
 * with two behaviours.
 *
 * The iteration count is stored inside each hash, so it can be raised later
 * without invalidating existing accounts: an old hash still verifies against
 * the cost it was written with.
 */
const ITERATIONS = 100_000;
const KEY_BITS = 256;
const SALT_BYTES = 16;

const b64 = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer)));

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    KEY_BITS,
  );
  return b64(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2$sha256$${ITERATIONS}$${b64(salt)}$${hash}`;
}

/** Constant-time compare, so verification cannot be turned into an oracle. */
function sameBytes(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, algo, iters, salt, hash] = stored.split("$");
    if (scheme !== "pbkdf2" || algo !== "sha256" || !iters || !salt || !hash) return false;
    return sameBytes(await derive(password, unb64(salt), Number(iters)), hash);
  } catch {
    return false;
  }
}

/**
 * A syntactically valid hash of a password nobody has. Verifying against this
 * when the account does not exist keeps a missing user and a wrong password
 * costing the same, so the endpoint cannot be used to enumerate names.
 */
export const DUMMY_HASH =
  `pbkdf2$sha256$${ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function startSession(store: Store, userId: number): Promise<string> {
  const token = newToken();
  const now = Date.now();
  await store.createSession(token, userId, now, now + SESSION_MS);
  return token;
}

export async function endSession(store: Store, token: string | null): Promise<void> {
  if (token) await store.dropSession(token);
}

export function sessionCookie(token: string, secure: boolean): string {
  const parts = [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_MS / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(secure: boolean): string {
  const parts = [`${COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function tokenFrom(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === COOKIE) return rest.join("=") || null;
  }
  return null;
}

export async function currentUser(store: Store, req: Request): Promise<UserRow | null> {
  const token = tokenFrom(req);
  if (!token) return null;
  return store.sessionUser(token, Date.now());
}

/* ------------------------------------------------------------------ */
/* Login throttle                                                      */
/* ------------------------------------------------------------------ */

export const THROTTLE_WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 12;

/** Enough to make online password guessing impractical. */
export async function throttled(store: Store, ip: string): Promise<boolean> {
  return (await store.attemptCount(ip, Date.now())) >= MAX_ATTEMPTS;
}
