import { CELLS, GRID, HUE_COUNT } from "./palette";
import { Rng, hashString } from "./prng";
import type { Bond, Grid, Rule } from "./rules";
import { evaluateRule, makeCtx, ruleWeight } from "./rules";
import type { ZoneScheme } from "./zones";
import { zoneCount, zoneMap } from "./zones";

export interface Puzzle {
  /** Stable identifier used as the leaderboard/solves key. */
  key: string;
  seed: string;
  title: string;
  scheme: ZoneScheme;
  rules: Rule[];
  bonds: Bond[];
  /** Max points awarded for a clean solve, before hint deductions. */
  points: number;
  /** Raw summed rule weight, kept for debugging / tuning. */
  difficulty: number;
  /** Every hue that appears anywhere in the reference solution. */
  hueSet: number[];
  /** Bond count of the reference solution — the "par" the UI shows. */
  parBonds: number;
}

/* ------------------------------------------------------------------ */
/* Puzzle keys                                                         */
/* ------------------------------------------------------------------ */

/** Endless ladder: puzzle #1, #2, #3 … Difficulty ramps with the index. */
export function ladderKey(n: number): string {
  return `L${n}`;
}

/** One shared puzzle per UTC day. */
export function dailyKey(date = new Date()): string {
  return `D${date.toISOString().slice(0, 10)}`;
}

export function isValidKey(key: string): boolean {
  if (/^L[1-9]\d{0,5}$/.test(key)) return true;
  if (/^D\d{4}-\d{2}-\d{2}$/.test(key)) return !Number.isNaN(Date.parse(key.slice(1)));
  return false;
}

export function ladderIndex(key: string): number | null {
  return /^L\d+$/.test(key) ? Number(key.slice(1)) : null;
}

/**
 * Difficulty tier 0..3. The ladder ramps; the daily sits in the middle so
 * everyone gets a comparable puzzle regardless of how far they've climbed.
 */
function tierFor(key: string): number {
  const n = ladderIndex(key);
  if (n === null) return 2;
  if (n <= 3) return 0;
  if (n <= 10) return 1;
  if (n <= 25) return 2;
  return 3;
}

/* ------------------------------------------------------------------ */
/* Value noise — gives the reference solution soft, blobby structure    */
/* ------------------------------------------------------------------ */

function lattice(rng: Rng, res: number): Float64Array {
  const a = new Float64Array((res + 1) * (res + 1));
  for (let i = 0; i < a.length; i++) a[i] = rng.next();
  return a;
}

function sampleLattice(a: Float64Array, res: number, u: number, v: number): number {
  const fx = u * res;
  const fy = v * res;
  const x0 = Math.min(res - 1, Math.floor(fx));
  const y0 = Math.min(res - 1, Math.floor(fy));
  const tx = smooth(fx - x0);
  const ty = smooth(fy - y0);
  const w = res + 1;
  const p00 = a[y0 * w + x0]!;
  const p10 = a[y0 * w + x0 + 1]!;
  const p01 = a[(y0 + 1) * w + x0]!;
  const p11 = a[(y0 + 1) * w + x0 + 1]!;
  return lerp(lerp(p00, p10, tx), lerp(p01, p11, tx), ty);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);

/* ------------------------------------------------------------------ */
/* Generation                                                          */
/* ------------------------------------------------------------------ */

function pickScheme(rng: Rng, tier: number): ZoneScheme {
  const easy: ZoneScheme[] = [
    { kind: "quadrants" },
    { kind: "bands", axis: "h", n: 2 },
    { kind: "bands", axis: "v", n: 2 },
    { kind: "bands", axis: "h", n: 3 },
    { kind: "bands", axis: "v", n: 3 },
  ];
  const spicy: ZoneScheme[] = [
    { kind: "rings", n: 3 },
    { kind: "rings", n: 4 },
    { kind: "diagonals", n: 3 },
    { kind: "diagonals", n: 4 },
    { kind: "bullseye" },
    { kind: "checker", block: 8 },
    { kind: "checker", block: 16 },
    { kind: "bands", axis: "h", n: 4 },
    { kind: "bands", axis: "v", n: 4 },
  ];
  if (tier === 0) return rng.pick(easy);
  if (tier === 1) return rng.pick(rng.bool(0.7) ? easy : spicy);
  return rng.pick(rng.bool(0.3) ? easy : spicy);
}

/**
 * Build the reference solution first, so a solution provably exists, then
 * read the rules back off it. Randomly sampling constraints and hoping they
 * are jointly satisfiable would produce unwinnable puzzles.
 */
function buildTarget(rng: Rng, scheme: ZoneScheme, tier: number): { target: Grid; zmap: Uint8Array } {
  const zmap = zoneMap(scheme);
  const nz = zoneCount(scheme);

  const globalHues = rng.sample(
    Array.from({ length: HUE_COUNT }, (_, i) => i),
    rng.range(tier <= 1 ? 5 : 6, HUE_COUNT),
  );

  const palettes: number[][] = [];
  for (let z = 0; z < nz; z++) {
    const size = rng.range(2, tier === 0 ? 3 : 4);
    palettes.push(rng.sample(globalHues, size));
  }

  // Two octaves of value noise keeps regions blobby instead of confetti,
  // which is what makes adjacency rules derivable at all.
  const res1 = rng.range(4, 8);
  const res2 = res1 * 2;
  const l1 = lattice(rng, res1);
  const l2 = lattice(rng, res2);

  const target = new Int8Array(CELLS);
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const u = x / GRID;
      const v = y / GRID;
      let t = sampleLattice(l1, res1, u, v) * 0.72 + sampleLattice(l2, res2, u, v) * 0.28;
      t = Math.min(0.9999, Math.max(0, t));
      const pal = palettes[zmap[y * GRID + x]!]!;
      target[y * GRID + x] = pal[Math.floor(t * pal.length)]!;
    }
  }

  plantDecorations(rng, target, zmap, nz, globalHues, tier);
  return { target, zmap };
}

/**
 * Deliberately plant structure the derivation step can find. Without this the
 * rule set would only ever contain zone + adjacency rules, because smooth
 * noise never happens to satisfy a parity or border constraint by accident.
 */
function plantDecorations(
  rng: Rng,
  target: Grid,
  zmap: Uint8Array,
  nz: number,
  globalHues: number[],
  tier: number,
): void {
  // --- Sprinkle: scatter one hue onto same-parity cells inside a few zones.
  // Same-parity cells are never orthogonally adjacent, so this single move
  // makes parity, lonely, noBlock and a tight quotaMax all derivable at once.
  if (tier >= 1 && rng.bool(0.75)) {
    const s = rng.pick(globalHues);
    const p = rng.int(2);
    const zones = new Set(rng.sample(Array.from({ length: nz }, (_, i) => i), Math.max(1, Math.ceil(nz / 2))));
    const density = 0.06 + rng.next() * 0.1;
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        if (((x + y) & 1) !== p) continue;
        const i = y * GRID + x;
        if (!zones.has(zmap[i]!)) continue;
        if (rng.next() < density) target[i] = s;
      }
    }
    // Scrub any pre-existing copies on the wrong parity so `parity` holds.
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const i = y * GRID + x;
        if (target[i] === s && ((x + y) & 1) !== p) target[i] = replacement(rng, target, zmap, i, s);
      }
    }
  }

  // --- Border ban: evict one hue from the outer band so a border rule holds.
  if (tier >= 2 && rng.bool(0.5)) {
    const b = rng.pick(globalHues);
    const d = rng.range(2, 5);
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        if (Math.min(x, y, GRID - 1 - x, GRID - 1 - y) >= d) continue;
        const i = y * GRID + x;
        if (target[i] === b) target[i] = replacement(rng, target, zmap, i, b);
      }
    }
  }
}

/** Nearest sensible substitute for a hue we are evicting from cell `i`. */
function replacement(rng: Rng, target: Grid, zmap: Uint8Array, i: number, avoid: number): number {
  const z = zmap[i]!;
  // Prefer a hue already used elsewhere in the same zone, so zone rules stay tight.
  const seen: number[] = [];
  const x0 = i % GRID;
  const y0 = (i / GRID) | 0;
  for (let r = 1; r <= 6 && seen.length === 0; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = x0 + dx;
        const ny = y0 + dy;
        if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
        const j = ny * GRID + nx;
        if (zmap[j] !== z) continue;
        const v = target[j]!;
        if (v !== avoid && v >= 0) seen.push(v);
      }
    }
  }
  if (seen.length) return rng.pick(seen);
  // Zone was entirely `avoid`; fall back to any other hue present on the grid.
  for (let j = 0; j < CELLS; j++) if (target[j] !== avoid && target[j]! >= 0) return target[j]!;
  return (avoid + 1) % HUE_COUNT;
}

/* ------------------------------------------------------------------ */
/* Rule derivation                                                     */
/* ------------------------------------------------------------------ */

function holds(rule: Rule, target: Grid, zmap: Uint8Array): boolean {
  const ctx = makeCtx(target, zmap);
  return evaluateRule(rule, target, ctx).status === "ok";
}

function deriveRules(rng: Rng, target: Grid, zmap: Uint8Array, scheme: ZoneScheme, tier: number): Rule[] {
  const nz = zoneCount(scheme);
  const counts = new Int32Array(HUE_COUNT);
  for (let i = 0; i < CELLS; i++) counts[target[i]!]!++;
  const used = Array.from({ length: HUE_COUNT }, (_, h) => h).filter((h) => counts[h]! > 0);

  // --- Zone rules: read straight off the reference solution, so they are
  // true by construction no matter what the decorations did.
  const zoneRules: Rule[] = [];
  const zonePalettes: number[][] = [];
  for (let z = 0; z < nz; z++) {
    const present = new Set<number>();
    for (let i = 0; i < CELLS; i++) if (zmap[i] === z) present.add(target[i]!);
    const hues = [...present].sort((a, b) => a - b);
    zonePalettes.push(hues);
    zoneRules.push({ t: "zone", zone: z, hues });
  }

  // --- Candidate extras. Every one is checked against the target below, so a
  // candidate that does not actually hold is simply dropped.
  const candidates: Rule[] = [];
  const pairs: [number, number][] = [];
  for (let i = 0; i < used.length; i++) {
    for (let j = i + 1; j < used.length; j++) pairs.push([used[i]!, used[j]!]);
  }

  for (const [a, b] of pairs) {
    // Skip pairs that would collapse a zone to a single colour — technically
    // solvable, but it reads as a broken puzzle rather than a clever one.
    const collapses = zonePalettes.some((p) => p.length === 2 && p.includes(a) && p.includes(b));
    if (collapses) continue;
    candidates.push({ t: "forbidAdj", a, b });
    candidates.push({ t: "farApart", a, b });
    candidates.push({ t: "requireAdj", a, b });
    candidates.push({ t: "requireAdj", a: b, b: a });
  }

  for (const a of used) {
    candidates.push({ t: "buddy", a });
    candidates.push({ t: "lonely", a });
    candidates.push({ t: "noBlock", a });
    candidates.push({ t: "parity", a, p: 0 });
    candidates.push({ t: "parity", a, p: 1 });
    for (const d of [2, 3, 4, 5]) {
      candidates.push({ t: "border", a, mode: "never", d });
      candidates.push({ t: "border", a, mode: "only", d });
    }
    // Quotas: generous enough to leave creative room, tight enough to bite.
    const c = counts[a]!;
    if (c >= 40) {
      candidates.push({ t: "quotaMax", a, max: Math.min(CELLS, Math.round(c * 1.18) + 12) });
      candidates.push({ t: "quotaMin", a, min: Math.max(1, Math.round(c * 0.55)) });
    }
    for (const axis of ["row", "col"] as const) {
      const tally = new Int32Array(GRID);
      for (let i = 0; i < CELLS; i++) {
        if (target[i] !== a) continue;
        tally[axis === "row" ? (i / GRID) | 0 : i % GRID]!++;
      }
      let worst = 0;
      for (const t of tally) worst = Math.max(worst, t);
      if (worst > 0 && worst < GRID - 6) {
        candidates.push({ t: "lineLimit", a, axis, max: Math.min(GRID, worst + 2) });
      }
    }
  }

  const valid = candidates.filter((r) => holds(r, target, zmap));

  // --- Pick a type-diverse subset so puzzles don't feel samey.
  const byKind = new Map<string, Rule[]>();
  for (const r of valid) {
    const list = byKind.get(r.t) ?? [];
    list.push(r);
    byKind.set(r.t, list);
  }
  for (const list of byKind.values()) rng.shuffle(list);

  const nExtra = [2, 3, 4, 5][tier]!;
  const kinds = rng.shuffle([...byKind.keys()]);
  const extras: Rule[] = [];
  const takenTopics = new Set<string>();

  const take = (r: Rule): boolean => {
    const topic = ruleTopic(r);
    if (takenTopics.has(topic)) return false;
    takenTopics.add(topic);
    extras.push(r);
    return true;
  };

  // First pass: one of each kind, for variety. Second pass: top up.
  for (const k of kinds) {
    if (extras.length >= nExtra) break;
    for (const r of byKind.get(k)!) if (take(r)) break;
  }
  for (const r of rng.shuffle([...byKind.values()].flat())) {
    if (extras.length >= nExtra) break;
    take(r);
  }

  return [...zoneRules, ...extras];
}

/**
 * Two rules about the same hue (or the same hue pair) read as padding, and in
 * the worst case one strictly implies the other — `farApart` already forbids
 * every adjacency `forbidAdj` does. One rule per topic.
 */
function ruleTopic(r: Rule): string {
  if (r.t === "zone") return `z${r.zone}`;
  const hues = "b" in r ? [r.a, (r as { b: number }).b].sort((x, y) => x - y) : [r.a];
  return `h${hues.join(",")}`;
}

/* ------------------------------------------------------------------ */
/* Bonds + scoring                                                     */
/* ------------------------------------------------------------------ */

export function countBonds(grid: Grid, bonds: Bond[]): number {
  if (!bonds.length) return 0;
  let n = 0;
  for (let i = 0; i < CELLS; i++) {
    const v = grid[i]!;
    if (v < 0) continue;
    const x = i % GRID;
    if (x < GRID - 1) n += bondHit(bonds, v, grid[i + 1]!);
    if (i + GRID < CELLS) n += bondHit(bonds, v, grid[i + GRID]!);
  }
  return n;
}

function bondHit(bonds: Bond[], u: number, v: number): number {
  if (v < 0) return 0;
  for (const b of bonds) {
    if ((b.a === u && b.b === v) || (b.a === v && b.b === u)) return 1;
  }
  return 0;
}

function pickBonds(rng: Rng, target: Grid, rules: Rule[]): Bond[] {
  // Only pairs that actually touch somewhere in the reference solution, and
  // never a pair some rule forbids from touching.
  const banned = new Set<string>();
  for (const r of rules) {
    if (r.t === "forbidAdj" || r.t === "farApart") {
      banned.add(pairKey(r.a, r.b));
    }
  }
  const seen = new Set<string>();
  for (let i = 0; i < CELLS; i++) {
    const v = target[i]!;
    const x = i % GRID;
    if (x < GRID - 1 && target[i + 1] !== v) seen.add(pairKey(v, target[i + 1]!));
    if (i + GRID < CELLS && target[i + GRID] !== v) seen.add(pairKey(v, target[i + GRID]!));
  }
  const options = [...seen]
    .filter((k) => !banned.has(k))
    .map((k) => {
      const [a, b] = k.split("-").map(Number);
      return { a: a!, b: b! };
    });
  return rng.sample(options, Math.min(2, options.length));
}

const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

/** Difficulty -> point value. Deliberately computed, never hand-set. */
export function pointsFor(rules: Rule[]): { points: number; difficulty: number } {
  // Observed difficulty runs ~6.5 (a tier-0 ladder puzzle) to ~17 (deep
  // ladder). This maps that span onto the 3..7 point band.
  const difficulty = rules.reduce((s, r) => s + ruleWeight(r), 0);
  const points = Math.max(3, Math.min(7, 3 + Math.round((difficulty - 7) / 2.2)));
  return { points, difficulty };
}

/* ------------------------------------------------------------------ */
/* Titles — pure flavour                                               */
/* ------------------------------------------------------------------ */

const ADJ = [
  "Soggy", "Feral", "Immaculate", "Suspicious", "Unhinged", "Velvet", "Crunchy", "Radiant",
  "Forbidden", "Deluxe", "Haunted", "Bashful", "Turbo", "Gelatinous", "Reluctant", "Cosmic",
  "Damp", "Regal", "Slippery", "Emotional", "Bewildered", "Chunky", "Serene", "Rowdy",
];
const NOUN = [
  "Waffle", "Committee", "Lagoon", "Situation", "Casserole", "Parade", "Bureaucracy", "Meadow",
  "Kerfuffle", "Sandwich", "Constellation", "Laundromat", "Opera", "Swamp", "Filing Cabinet",
  "Pancake", "Symposium", "Gremlin", "Aquarium", "Tantrum", "Cathedral", "Noodle", "Vortex",
];

function titleFor(rng: Rng): string {
  return `The ${rng.pick(ADJ)} ${rng.pick(NOUN)}`;
}

/* ------------------------------------------------------------------ */
/* Public entry points                                                 */
/* ------------------------------------------------------------------ */

const cache = new Map<string, { puzzle: Puzzle; target: Grid }>();

/** Deterministic for a given key. Cached because the UI asks for it constantly. */
export function generate(key: string): { puzzle: Puzzle; target: Grid } {
  const hit = cache.get(key);
  if (hit) return hit;

  const seed = `pixe-v1:${key}`;
  const tier = tierFor(key);
  const rng = new Rng(hashString(seed));

  const scheme = pickScheme(rng, tier);
  const { target, zmap } = buildTarget(rng, scheme, tier);
  const rules = deriveRules(rng, target, zmap, scheme, tier);
  const bonds = pickBonds(rng, target, rules);
  const { points, difficulty } = pointsFor(rules);

  const hueSet = [...new Set(Array.from(target))].sort((a, b) => a - b);

  const puzzle: Puzzle = {
    key,
    seed,
    title: titleFor(rng),
    scheme,
    rules,
    bonds,
    points,
    difficulty,
    hueSet,
    parBonds: countBonds(target, bonds),
  };

  const out = { puzzle, target };
  if (cache.size > 256) cache.clear();
  cache.set(key, out);
  return out;
}

/** Puzzle only — the reference solution never leaves the module in the client. */
export function generatePuzzle(key: string): Puzzle {
  return generate(key).puzzle;
}
