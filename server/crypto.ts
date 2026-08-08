/**
 * The four signing primitives the server is built on, and nothing else.
 *
 * They used to live at the top of `server/attest.ts`, which is gone along with
 * the rest of the browser-attestation machinery. They are here rather than
 * inlined into `runs.ts` because the run token, the chained sequence and the
 * dialect label all sign with them, and one implementation of "how do we HMAC"
 * is the only number of implementations worth having.
 *
 * WebCrypto only: this module is loaded unchanged on Bun and in a Cloudflare
 * Worker, and reaches for no Node built-in.
 */

const keyCache = new Map<string, Promise<CryptoKey>>();

/**
 * HMAC keys are derived per run secret and cached per isolate. Importing a key
 * costs more than signing with it, and a busy run signs on most round trips.
 */
function macKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    // Bounded: a busy Worker isolate would otherwise pin every run it has seen.
    if (keyCache.size > 512) keyCache.clear();
    keyCache.set(secret, k);
  }
  return k;
}

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = new Uint8Array(bytes as ArrayBuffer);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Base64url of HMAC-SHA256. Every call site prefixes a distinct domain tag. */
export async function hmac(secret: string, msg: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await macKey(secret), new TextEncoder().encode(msg));
  return b64url(sig);
}

/** SHA-256, hex. Used for the chain's solution digest. */
export async function sha256Hex(msg: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time, so no comparison here can be turned into an oracle. */
export function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const randB64 = (bytes: number) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

export const randHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
