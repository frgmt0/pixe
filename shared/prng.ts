/**
 * Deterministic PRNG. Both client and server derive an identical puzzle from a
 * seed string, so the server never has to trust anything the client says about
 * which rules it was playing under.
 */

/** FNV-1a. Stable across platforms; only used to turn a seed string into a u32. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  private s: number;

  constructor(seed: number | string) {
    this.s = (typeof seed === "string" ? hashString(seed) : seed >>> 0) || 0x9e3779b9;
  }

  /** mulberry32 */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Integer in [lo, hi] inclusive. */
  range(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)]!;
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  /** Fisher-Yates, in place. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr;
  }

  /** `k` distinct elements, order randomised. */
  sample<T>(arr: readonly T[], k: number): T[] {
    return this.shuffle(arr.slice()).slice(0, Math.min(k, arr.length));
  }
}
