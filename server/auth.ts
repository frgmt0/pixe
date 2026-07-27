import { q, type UserRow } from "./db";

const COOKIE = "pixe_sid";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PROD = process.env.NODE_ENV === "production";

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

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function startSession(userId: number): string {
  const token = newToken();
  const now = Date.now();
  q.createSession.run(token, userId, now, now + SESSION_MS);
  return token;
}

export function endSession(token: string | null): void {
  if (token) q.dropSession.run(token);
}

export function sessionCookie(token: string): string {
  const parts = [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_MS / 1000)}`,
  ];
  if (PROD) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(): string {
  const parts = [`${COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (PROD) parts.push("Secure");
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

export function currentUser(req: Request): UserRow | null {
  const token = tokenFrom(req);
  if (!token) return null;
  return q.sessionUser.get(token, Date.now()) ?? null;
}

/**
 * Small in-memory throttle on the auth endpoints. Enough to make online
 * password guessing impractical without dragging in a dependency.
 */
const attempts = new Map<string, { n: number; until: number }>();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 12;

export function throttled(ip: string): boolean {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.until) {
    attempts.delete(ip);
    return false;
  }
  return rec.n >= MAX_ATTEMPTS;
}

export function noteAttempt(ip: string): void {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.until) attempts.set(ip, { n: 1, until: now + WINDOW_MS });
  else rec.n++;
  if (attempts.size > 5000) {
    for (const [k, v] of attempts) if (now > v.until) attempts.delete(k);
  }
}

export function clearAttempts(ip: string): void {
  attempts.delete(ip);
}
