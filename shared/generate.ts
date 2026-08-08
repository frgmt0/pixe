import { buildBoard, ensureZoneVariety, pickScheme, plantStructure, tidyZones } from "./build";
import {
  DEFAULT_OPTS, deriveCandidates, deriveZoneRules, harden, selectRules, type DeriveOpts,
} from "./laws";
import { CELLS, GRID } from "./palette";
import { Rng, hashString } from "./prng";
import type { Bond, Grid, Rule } from "./rules";
import { ruleWeight } from "./rules";
import type { ZoneScheme } from "./zones";
import { zoneCount, zoneMap } from "./zones";

/** One cell handed to the agent already painted, and which must come back so. */
export interface LockedCell {
  x: number;
  y: number;
  hue: number;
}

export interface Puzzle {
  /** Stable identifier used as the leaderboard/solves key. */
  key: string;
  seed: string;
  title: string;
  scheme: ZoneScheme;
  rules: Rule[];
  bonds: Bond[];
  /** Max points awarded for a clean solve of this phase. */
  points: number;
  /** Raw summed rule weight, kept for debugging / tuning. */
  difficulty: number;
  /** Every hue that appears anywhere in the reference solution. */
  hueSet: number[];
  /** Bond count of the reference solution — the "par" the UI shows. */
  parBonds: number;
  /** 1-based position in this rung's phase chain. */
  phase: number;
  /** How many phases this rung has in total. Entitled information. */
  phases: number;
  /** Cells pre-filled from the agent's own accepted grid for the phase before. */
  locked: LockedCell[];
}

/* ------------------------------------------------------------------ */
/* The ladder                                                          */
/* ------------------------------------------------------------------ */

/**
 * How wide the ladder is, and the single number the whole difficulty curve is
 * expressed against.
 *
 * Every band below is a *fraction* of this rather than an absolute rung number,
 * so renumbering the ladder moves the curve with it instead of stranding the
 * top half of the boards in the opening tier.
 */
export const LADDER_SIZE = 500;

/** The most phases any single rung is ever split into. */
export const MAX_PHASES = 3;

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
 * Difficulty tier 0..5, as a fraction of the ladder.
 *
 *   0  L1-L3        the opening. One plant, two extra laws, one phase — a run
 *                   has to be able to get off the ground.
 *   1  ..4%         two plants, three laws. Still only the original twelve.
 *   2  ..12%        the exotic families come in: geometry, runs, topology.
 *   3  ..30%        arithmetic families join, laws may double up on a hue.
 *   4  ..60%        dense law sets, and two phases.
 *   5  the rest     the top of the ladder: three phases, three laws per hue.
 *
 * The daily sits at tier 2 so everyone gets a comparable puzzle regardless of
 * how far up the ladder they have climbed.
 */
const TIER_BREAKS = [0.006, 0.04, 0.12, 0.3, 0.6];

export function tierFor(key: string): number {
  const n = ladderIndex(key);
  if (n === null) return 2;
  const p = n / LADDER_SIZE;
  for (let t = 0; t < TIER_BREAKS.length; t++) if (p <= TIER_BREAKS[t]!) return t;
  return TIER_BREAKS.length;
}

/**
 * How many phases a rung is split into.
 *
 * A phase is a whole 64×64 board with its own zone scheme and its own law set,
 * and phase k+1's laws are derived from the agent's accepted grid for phase k.
 * The clock runs across all of them and the rung banks only when the last one
 * is accepted, so a three-phase rung is not three puzzles — it is one puzzle
 * that cannot be attacked in parallel with itself.
 */
export function phaseCountFor(key: string): number {
  const n = ladderIndex(key);
  if (n === null) return 1;
  const p = n / LADDER_SIZE;
  if (p <= 0.3) return 1;
  if (p <= 0.62) return 2;
  return MAX_PHASES;
}

/** How many laws past the zone laws a tier asks for. */
export const EXTRAS_PER_TIER = [2, 3, 5, 7, 9, 11];
/** How many laws a tier will state about one hue or hue pair. */
export const TOPIC_BUDGET_PER_TIER = [1, 1, 1, 2, 2, 3];

export const extrasForTier = (tier: number) =>
  EXTRAS_PER_TIER[Math.min(tier, EXTRAS_PER_TIER.length - 1)]!;
export const topicBudgetForTier = (tier: number) =>
  TOPIC_BUDGET_PER_TIER[Math.min(tier, TOPIC_BUDGET_PER_TIER.length - 1)]!;

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

export const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

export function pickBonds(rng: Rng, target: Grid, rules: Rule[]): Bond[] {
  // Only pairs that actually touch somewhere in the reference solution, and
  // never a pair some rule forbids from touching.
  const banned = new Set<string>();
  for (const r of rules) {
    if (r.t === "forbidAdj" || r.t === "farApart") banned.add(pairKey(r.a, r.b));
    if (r.t === "exclusive") banned.add(pairKey(r.a, r.b));
  }
  const seen = new Set<string>();
  for (let i = 0; i < CELLS; i++) {
    const v = target[i]!;
    if (i % GRID < GRID - 1 && target[i + 1] !== v) seen.add(pairKey(v, target[i + 1]!));
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

/**
 * Difficulty -> point value. Deliberately computed, never hand-set.
 *
 * The band used to be 3-7, sized for a corpus whose hardest board carried five
 * laws off a twelve-primitive menu. It is 3-12 now, for two reasons that are
 * both about honesty rather than generosity: the top of the ladder carries
 * thirteen laws off a twenty-six-primitive menu and really is several times the
 * work, and a rung's points are the sum over its phases — so a three-phase rung
 * at the top of the ladder pays up to 36, and a run that grinds one out has
 * banked something a 7 could not describe.
 *
 * Measured over 400 ladder puzzles: difficulty runs ~11 (tier 0) to ~45
 * (tier 5), and the map below sends that span onto the band linearly.
 */
export const POINTS_MIN = 3;
export const POINTS_MAX = 12;

export function pointsFor(rules: Rule[]): { points: number; difficulty: number } {
  const difficulty = rules.reduce((s, r) => s + ruleWeight(r), 0);
  const points = Math.max(
    POINTS_MIN,
    Math.min(POINTS_MAX, POINTS_MIN + Math.round((difficulty - 11) / 3.5)),
  );
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

export function titleFor(rng: Rng): string {
  return `The ${rng.pick(ADJ)} ${rng.pick(NOUN)}`;
}

/* ------------------------------------------------------------------ */
/* Derivation, shared by the base generator and every dialect           */
/* ------------------------------------------------------------------ */

/**
 * Read a complete law set off a finished reference solution.
 *
 * The single entry point both the base generator and the per-run dialect go
 * through, so "the laws are read off a real solution" is one implementation
 * rather than two that drift. `resists` reports whether the adversarial pass
 * managed to kill every no-thought fill; a caller that gets `false` should
 * redraw rather than ship the board.
 */
export function lawsFor(
  rng: Rng,
  target: Grid,
  zmap: Uint8Array,
  nz: number,
  opts: DeriveOpts,
  forced: Rule[] = [],
): { rules: Rule[]; resists: boolean } {
  const { zoneRules, palettes } = deriveZoneRules(target, zmap, nz, opts.floorFactor);
  const candidates = deriveCandidates(target, zmap, nz, opts);
  const nExtra = extrasForTier(opts.tier);
  const budget = topicBudgetForTier(opts.tier);
  const { extras, topics } = selectRules(rng, candidates, nExtra, budget);
  const live = [...zoneRules, ...forced, ...extras];
  const resists = harden(rng, live, extras, candidates, topics, zmap, palettes, budget);
  return { rules: [...zoneRules, ...forced, ...extras], resists };
}

/**
 * Build a reference solution for `tier` and read its laws back off it.
 *
 * `mutate` is the hook a later phase uses to fold in constraints derived from
 * the agent's own accepted grid — it may edit the target however it likes, and
 * because the laws are derived afterwards, nothing it does can make the board
 * unsolvable. `forced` are laws the caller insists on; they are checked against
 * the target by the caller, not here.
 */
export interface BoardMutation {
  /** Cells that may not be repainted by any later pass. */
  locked?: Uint8Array;
  /** Laws the caller insists on, already true of the target it just edited. */
  forced?: Rule[];
  /**
   * A second edit, run after tidying and the variety pass. Anything that fixes
   * a *count* belongs here: tidying moves counts around, so a bound enforced
   * before it would not survive. Returns the laws that edit guarantees.
   */
  after?: (target: Grid, zmap: Uint8Array, nz: number) => Rule[];
}

export function composeBoard(
  rng: Rng,
  tier: number,
  opts: DeriveOpts,
  mutate?: (target: Grid, zmap: Uint8Array, nz: number) => BoardMutation,
  scheme0?: ZoneScheme,
): { scheme: ZoneScheme; target: Grid; zmap: Uint8Array; rules: Rule[]; resists: boolean } {
  const scheme = scheme0 ?? pickScheme(rng, tier);
  const { target, zmap } = buildBoard(rng, scheme, tier);
  const nz = zoneCount(scheme);
  plantStructure(rng, target, zmap, nz, tier);

  const hook = mutate?.(target, zmap, nz);
  const locked = hook?.locked;
  const lockedHues = new Set<string>();
  if (locked) {
    for (let i = 0; i < CELLS; i++) if (locked[i]) lockedHues.add(`${zmap[i]}:${target[i]}`);
  }

  tidyZones(target, zmap, nz, locked ? (z, h) => lockedHues.has(`${z}:${h}`) : undefined);
  ensureZoneVariety(rng, target, zmap, nz, locked);

  const forced = [...(hook?.forced ?? []), ...(hook?.after?.(target, zmap, nz) ?? [])];
  const { rules, resists } = lawsFor(rng, target, zmap, nz, opts, forced);
  return { scheme, target, zmap, rules, resists };
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
  const opts: DeriveOpts = { ...DEFAULT_OPTS, tier };

  // `harden` fixes almost every puzzle that a mechanical fill would otherwise
  // beat, but it can only add laws that are actually true of the reference
  // solution — and occasionally that pool runs dry. Such a board is simply a
  // weak one: no available law can tell a thoughtless pattern apart from a real
  // answer. Rather than ship it, redraw and try again. Deterministic, because
  // the retry counter feeds the seed.
  let built!: ReturnType<typeof composeBoard>;
  let rng!: Rng;
  for (let attempt = 0; ; attempt++) {
    rng = new Rng(hashString(attempt === 0 ? seed : `${seed}#${attempt}`));
    built = composeBoard(rng, tier, opts);
    if (built.resists || attempt >= 8) break;
  }

  const { target, rules, scheme } = built;
  const bonds = pickBonds(rng, target, rules);
  const { points, difficulty } = pointsFor(rules);

  const puzzle: Puzzle = {
    key,
    seed,
    title: titleFor(rng),
    scheme,
    rules,
    bonds,
    points,
    difficulty,
    hueSet: [...new Set(Array.from(target))].sort((a, b) => a - b),
    parBonds: countBonds(target, bonds),
    phase: 1,
    phases: phaseCountFor(key),
    locked: [],
  };

  const out = { puzzle, target };
  // Each entry is a 4KB grid plus a small object, so this caps out around 5MB —
  // bounded, and it keeps repeat lookups free.
  if (cache.size > 1024) cache.clear();
  cache.set(key, out);
  return out;
}

/** Puzzle only — the reference solution never leaves the module in the client. */
export function generatePuzzle(key: string): Puzzle {
  return generate(key).puzzle;
}

/** Zone map for a puzzle, memoised. Both assessment paths want it on every probe. */
const zmapCache = new Map<string, Uint8Array>();

export function zmapForScheme(id: string, scheme: ZoneScheme): Uint8Array {
  let m = zmapCache.get(id);
  if (!m) {
    m = zoneMap(scheme);
    if (zmapCache.size > 256) zmapCache.clear();
    zmapCache.set(id, m);
  }
  return m;
}
