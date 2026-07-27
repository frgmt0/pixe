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

function deriveRules(
  rng: Rng,
  target: Grid,
  zmap: Uint8Array,
  scheme: ZoneScheme,
  tier: number,
): { rules: Rule[]; resists: boolean } {
  const nz = zoneCount(scheme);
  const counts = new Int32Array(HUE_COUNT);
  for (let i = 0; i < CELLS; i++) counts[target[i]!]!++;
  const used = Array.from({ length: HUE_COUNT }, (_, h) => h).filter((h) => counts[h]! > 0);

  // --- Zone rules: read straight off the reference solution, so they are
  // true by construction no matter what the decorations did.
  //
  // `each` turns the permit list into a requirement list: every listed hue has
  // to cover real ground here. That is what forces the whole palette onto the
  // board, which in turn is what stops the hue-keyed rules below from being
  // dodged into vacuous truth by simply never painting the hue they name.
  //
  // It is derived from the scarcest hue in the zone and then halved, so the
  // reference solution clears it with room to spare and the player is never
  // asked to match an exact count.
  const zoneRules: Rule[] = [];
  const zonePalettes: number[][] = [];
  for (let z = 0; z < nz; z++) {
    const inZone = new Map<number, number>();
    for (let i = 0; i < CELLS; i++) {
      if (zmap[i] === z) inZone.set(target[i]!, (inZone.get(target[i]!) ?? 0) + 1);
    }
    const hues = [...inZone.keys()].sort((a, b) => a - b);
    const scarcest = Math.min(...hues.map((h) => inZone.get(h)!));
    zonePalettes.push(hues);
    // Never above `scarcest`, or the reference solution would fail its own
    // rule; never below 2 unless the target genuinely leaves no room, because
    // a floor of 1 is the token-cell loophole all over again.
    const each = Math.min(scarcest, Math.max(2, Math.floor(scarcest * 0.5)));
    zoneRules.push({ t: "zone", zone: z, hues, each });
  }

  // --- Candidate extras. Every one is checked against the target below, so a
  // candidate that does not actually hold is simply dropped.
  const candidates: Rule[] = [];
  const pairs: [number, number][] = [];
  for (let i = 0; i < used.length; i++) {
    for (let j = i + 1; j < used.length; j++) pairs.push([used[i]!, used[j]!]);
  }

  for (const [a, b] of pairs) {
    // A two-hue zone whose pair may not touch used to be skipped as
    // "collapsing", but the coverage floor now forces both hues to hold real
    // ground, so the zone resolves to an interleaved pattern rather than a
    // single colour. Keeping these matters: pair rules are the main thing that
    // rejects a mechanical fill, and two-hue zones are precisely the puzzles
    // that were still falling to one.
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

  const resists = harden(rng, zoneRules, extras, valid, takenTopics, zmap, zonePalettes);
  return { rules: [...zoneRules, ...extras], resists };
}

/** True when `b` adds nothing on top of `a`, because `a` already implies it. */
function redundant(a: Rule, b: Rule): boolean {
  if (a.t === "farApart" && b.t === "forbidAdj") {
    return (a.a === b.a && a.b === b.b) || (a.a === b.b && a.b === b.a);
  }
  // A hue confined to one checkerboard parity can never touch itself, which
  // already gives you `lonely`, and `lonely` already gives you `noBlock`.
  if (a.t === "parity" && (b.t === "lonely" || b.t === "noBlock")) return a.a === b.a;
  if (a.t === "lonely" && b.t === "noBlock") return a.a === b.a;
  return false;
}

/**
 * Adversarial pass: a puzzle must not fall to a strategy that involves no
 * deduction at all.
 *
 * The zone coverage floor killed solid fills, but the next thing anyone tries
 * is a mechanical pattern, and those are alarmingly good at constraint
 * satisfaction by accident — a checkerboard satisfies `lonely`, `noBlock`,
 * `parity` and `requireAdj` simultaneously; stripes satisfy `buddy`,
 * `requireAdj` and `noBlock`. With only 2-5 extra laws, the odds that a whole
 * rule set happens to be pattern-compatible are not small: measured at 21% of
 * the ladder before this pass existed.
 *
 * So rather than guess which laws are pattern-hostile, we check. Every cheap
 * grid that still validates gets a law added specifically to break it. This
 * generalises — a newly discovered cheap strategy only has to be added to
 * `cheapFills` and every puzzle hardens against it automatically.
 */
function harden(
  rng: Rng,
  zoneRules: Rule[],
  extras: Rule[],
  valid: Rule[],
  takenTopics: Set<string>,
  zmap: Uint8Array,
  palettes: number[][],
): boolean {
  const decoys = cheapFills(zmap, palettes).map((g) => ({ g, ctx: makeCtx(g, zmap) }));
  const live = [...zoneRules, ...extras];

  // Bounded so a pathological puzzle cannot spin, and so the rule list stays
  // short enough to read in the post-solve reveal.
  for (let round = 0; round < 8; round++) {
    const survivors = decoys.filter(({ g, ctx }) =>
      live.every((r) => evaluateRule(r, g, ctx).status === "ok"),
    );
    if (!survivors.length) return true;

    // Topic uniqueness is an aesthetic preference — two laws about one hue read
    // as padding. Resisting a no-thought solution is not aesthetic, so it wins
    // the tie: here a taken topic is allowed, and only genuine redundancy
    // (a law another law already implies) is filtered out.
    const pool = rng.shuffle(
      valid.filter((r) => !takenTopics.has(ruleTopic(r)) || live.every((e) => !redundant(e, r))),
    );
    let best: Rule | null = null;
    let bestKills = 0;
    for (const r of pool) {
      let kills = 0;
      for (const { g, ctx } of survivors) {
        if (evaluateRule(r, g, ctx).status !== "ok") kills++;
      }
      if (kills > bestKills) {
        best = r;
        bestKills = kills;
        // Nothing beats killing every survivor, so stop looking.
        if (kills === survivors.length) break;
      }
    }
    if (!best) return false; // Nothing left in the pool can help.
    takenTopics.add(ruleTopic(best));
    extras.push(best);
    live.push(best);
  }
  // Ran out of rounds with decoys still standing.
  return false;
}

/**
 * The cheap-strategy family: fills that need no understanding of the puzzle.
 * Each zone gets its own permitted palette cycled through a mechanical
 * pattern, which clears the zone laws and the coverage floor by construction —
 * so whatever rejects these has to be a real constraint.
 */
function cheapFills(zmap: Uint8Array, palettes: number[][]): Grid[] {
  const patterns: ((x: number, y: number) => number)[] = [
    () => 0, // solid
    (x, y) => x + y, // checkerboard
    (x, y) => y, // horizontal stripes
    (x, y) => x, // vertical stripes
    (x, y) => (x >> 1) + (y >> 1), // 2x2 blocks
    (x, y) => (x + y) >> 2, // diagonal bands
    (x, y) => y >> 2, // thick horizontal bands
    (x, y) => x >> 2, // thick vertical bands
  ];
  const out: Grid[] = [];
  for (const pat of patterns) {
    for (let rot = 0; rot < 4; rot++) {
      const g = new Int8Array(CELLS);
      for (let i = 0; i < CELLS; i++) {
        const pal = palettes[zmap[i]!]!;
        g[i] = pal[(pat(i % GRID, (i / GRID) | 0) + rot) % pal.length]!;
      }
      out.push(g);
    }
  }
  return out;
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
  // Measured over 300 ladder puzzles: difficulty runs ~10.6 (tier 0) to ~23.4
  // (deep ladder), median ~17. This maps that span onto the 3..7 point band so
  // the middle of the ladder pays the middle of the band.
  const difficulty = rules.reduce((s, r) => s + ruleWeight(r), 0);
  const points = Math.max(3, Math.min(7, 3 + Math.round((difficulty - 11) / 3)));
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

  // `harden` fixes almost every puzzle that a mechanical fill would otherwise
  // beat, but it can only add laws that are actually true of the reference
  // solution — and occasionally that pool runs dry. Such a board is simply a
  // weak one: no available law can tell a thoughtless pattern apart from a
  // real answer. Rather than ship it, redraw and try again. Deterministic,
  // because the retry counter feeds the seed.
  let scheme!: ZoneScheme;
  let target!: Grid;
  let zmap!: Uint8Array;
  let rules!: Rule[];
  let rng!: Rng;
  for (let attempt = 0; ; attempt++) {
    rng = new Rng(hashString(attempt === 0 ? seed : `${seed}#${attempt}`));
    scheme = pickScheme(rng, tier);
    ({ target, zmap } = buildTarget(rng, scheme, tier));
    const derived = deriveRules(rng, target, zmap, scheme, tier);
    rules = derived.rules;
    // 8 redraws is far more than anything observed; the bound only exists so a
    // hypothetical pathological seed cannot hang the client.
    if (derived.resists || attempt >= 8) break;
  }

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
  // Generation costs ~17ms now that every puzzle is adversarially hardened, so
  // the cache has to comfortably outlive a working set rather than thrash
  // against it. Each entry is a 4KB grid plus a small object, so this caps out
  // around 5MB — bounded, and it keeps repeat lookups free.
  if (cache.size > 1024) cache.clear();
  cache.set(key, out);
  return out;
}

/** Puzzle only — the reference solution never leaves the module in the client. */
export function generatePuzzle(key: string): Puzzle {
  return generate(key).puzzle;
}
