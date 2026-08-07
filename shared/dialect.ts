/**
 * Per-run rule dialects.
 *
 * Two runs handed the same ladder key must not be playing the same board. The
 * ladder is only ~1M keys wide and a run's key stream is public the moment it
 * is issued, so without this a solver that has seen L4271 once could recognise
 * it forever, and boards would transfer between runs the way they transferred
 * between puzzles before the chained sequence existed.
 *
 * The generator's load-bearing invariant is that the reference solution is
 * built first and the laws are read back off it, which is the only reason a
 * solution provably exists. A dialect must not touch that ordering, so it hooks
 * in exactly where the generator does: it perturbs the *reference solution*,
 * then re-derives every law against the perturbed grid. Every law kept here has
 * been evaluated against the final target, so the target is a solution by
 * construction, same as upstream.
 *
 * Three perturbations, in order, each seeded from the run's salt:
 *
 *   1. A global hue permutation. Cheap, and it relabels every law at once.
 *   2. A re-plant: a parity sprinkle, a border eviction, and a zone-local hue
 *      swap. The swap is the important one — a global permutation is a single
 *      secret an attacker can recover once and reuse for the rest of the run,
 *      whereas a per-zone swap is not expressible as one.
 *   3. A tidy: hues that hold less than `MIN_ZONE_COVER` cells of a zone are
 *      absorbed into their neighbours. Perturbation tends to scatter thin
 *      traces of a hue into zones it does not belong in, and a zone law naming
 *      a hue that covers nine cells is a coverage floor of two — the token-cell
 *      loophole all over again.
 *
 * Then the law set is re-derived with jittered thresholds and re-hardened
 * against the same no-thought fills the generator defends against, because a
 * dialect that quietly produced solid-fillable boards would be worse than no
 * dialect at all.
 */

import { countBonds, generate, ladderIndex, pointsFor, type Puzzle } from "./generate";
import { CELLS, GRID, HUE_COUNT } from "./palette";
import { Rng, hashString } from "./prng";
import { evaluateRule, makeCtx, type Bond, type Grid, type Rule, type RuleEval } from "./rules";
import { zoneCount, zoneMap } from "./zones";
import type { Assessment } from "./validate";

/** Bumping this invalidates every stored dialect. Runs in flight would break. */
export const DIALECT_VERSION = 1;

/**
 * A hue below this in a zone is noise, not a colour the zone is "about".
 * Naming it in the zone law would hand the player a floor of two cells.
 */
const MIN_ZONE_COVER = 10;
/** Zone palettes wider than this stop constraining anything. */
const MAX_ZONE_HUES = 4;

/**
 * 128 bits, hex. Never leaves the server: a client holding the salt can
 * re-derive the laws, which is precisely what this exists to prevent.
 */
export function newDialectSalt(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function isDialectSalt(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{32}$/.test(s);
}

/**
 * One PRNG per phase rather than one per puzzle, so a change to how laws are
 * picked cannot silently re-roll the board the laws are picked from.
 */
function rngFor(salt: string, key: string, tag: string): Rng {
  return new Rng(hashString(`pixe-dialect/${DIALECT_VERSION}:${salt}:${key}:${tag}`));
}

/** Same bands as the generator's, which is not exported. Keep in step with it. */
function tierFor(key: string): number {
  const n = ladderIndex(key);
  if (n === null) return 2;
  if (n <= 3) return 0;
  if (n <= 10) return 1;
  if (n <= 25) return 2;
  return 3;
}

/* ------------------------------------------------------------------ */
/* Perturbing the reference solution                                   */
/* ------------------------------------------------------------------ */

/**
 * The nearest hue to cell `i`, inside the same zone, that `ok` accepts. Used
 * whenever a hue is evicted: reaching for a neighbour rather than a random
 * substitute is what keeps regions blobby, and blobby is what makes adjacency
 * laws derivable at all.
 */
function nearby(target: Grid, zmap: Uint8Array, i: number, ok: (h: number) => boolean): number {
  const z = zmap[i]!;
  const x0 = i % GRID;
  const y0 = (i / GRID) | 0;
  for (let r = 1; r <= 6; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = x0 + dx;
        const ny = y0 + dy;
        if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
        const j = ny * GRID + nx;
        if (zmap[j] !== z) continue;
        const v = target[j]!;
        if (v >= 0 && ok(v)) return v;
      }
    }
  }
  return -1;
}

function huePermutation(rng: Rng): number[] {
  return rng.shuffle([...Array(HUE_COUNT).keys()]);
}

/**
 * Re-plant structure on top of the permuted solution. Deliberately the same
 * three moves the generator makes, for the same reason: smooth noise never
 * satisfies a parity or border constraint by accident, so without planting them
 * the derivation step can only ever find zone and adjacency laws.
 */
function replant(rng: Rng, target: Grid, zmap: Uint8Array, nz: number): void {
  const present = () => {
    const seen = new Set<number>();
    for (let i = 0; i < CELLS; i++) seen.add(target[i]!);
    return [...seen].sort((a, b) => a - b);
  };

  // --- Per-zone palette permutation, applied before anything else.
  //
  // The global permutation above is a single secret: recover it once from one
  // solved board and it explains every other board in the run. A permutation
  // chosen independently per zone is not expressible as one global relabelling,
  // so recovering it in one region says nothing about the next.
  for (let z = 0; z < nz; z++) {
    const inZone = new Set<number>();
    for (let i = 0; i < CELLS; i++) if (zmap[i] === z) inZone.add(target[i]!);
    const hues = [...inZone].sort((a, b) => a - b);
    if (hues.length < 2) continue;
    const shuffled = rng.shuffle(hues.slice());
    const map = new Map(hues.map((h, k) => [h, shuffled[k]!]));
    for (let i = 0; i < CELLS; i++) {
      if (zmap[i] === z) target[i] = map.get(target[i]!)!;
    }
  }

  // --- Parity sprinkle. Same-parity cells are never orthogonally adjacent, so
  // this makes parity, lonely, noBlock and a tight quota derivable at once.
  // Always applied: it is the only perturbation that rewrites cell *content*
  // rather than relabelling it, and content is what a stolen grid consists of.
  {
    const hues = present();
    const s = rng.pick(hues);
    const p = rng.int(2);
    const zones = new Set(
      rng.sample([...Array(nz).keys()], Math.max(1, Math.ceil(nz / 2))),
    );
    const density = 0.08 + rng.next() * 0.1;
    for (let i = 0; i < CELLS; i++) {
      if (((i % GRID) + ((i / GRID) | 0)) % 2 !== p) continue;
      if (!zones.has(zmap[i]!)) continue;
      if (rng.next() < density) target[i] = s;
    }
    // Scrub copies on the wrong parity anywhere on the board, or `parity` does
    // not hold globally and the law we just planted is not derivable.
    for (let i = 0; i < CELLS; i++) {
      if (target[i] !== s) continue;
      if (((i % GRID) + ((i / GRID) | 0)) % 2 === p) continue;
      const alt = nearby(target, zmap, i, (h) => h !== s);
      target[i] = alt >= 0 ? alt : (s + 1) % HUE_COUNT;
    }
  }

  // --- Border eviction, so a `border` law becomes true.
  if (rng.bool(0.6)) {
    const hues = present();
    if (hues.length > 2) {
      const b = rng.pick(hues);
      const d = rng.range(2, 5);
      for (let i = 0; i < CELLS; i++) {
        if (target[i] !== b) continue;
        const x = i % GRID;
        const y = (i / GRID) | 0;
        if (Math.min(x, y, GRID - 1 - x, GRID - 1 - y) >= d) continue;
        const alt = nearby(target, zmap, i, (h) => h !== b);
        target[i] = alt >= 0 ? alt : (b + 1) % HUE_COUNT;
      }
    }
  }

  // --- Zone-local hue swap. The one perturbation a global relabelling cannot
  // express: two runs can share a hue permutation and still disagree about
  // which colour owns which region.
  const swaps = rng.range(1, Math.max(1, Math.min(3, nz)));
  for (let n = 0; n < swaps; n++) {
    const z = rng.int(nz);
    const inZone = new Set<number>();
    for (let i = 0; i < CELLS; i++) if (zmap[i] === z) inZone.add(target[i]!);
    const hues = [...inZone];
    if (hues.length < 2) continue;
    const [a, b] = rng.sample(hues, 2) as [number, number];
    for (let i = 0; i < CELLS; i++) {
      if (zmap[i] !== z) continue;
      if (target[i] === a) target[i] = b;
      else if (target[i] === b) target[i] = a;
    }
  }
}

/**
 * Absorb hues that hold no real ground in a zone, and cap how wide a zone
 * palette may get. Both directions matter: a thin trace turns the coverage
 * floor back into a token cell, and a zone that permits six of eight hues
 * permits everything.
 */
function tidyZones(target: Grid, zmap: Uint8Array, nz: number): void {
  for (let z = 0; z < nz; z++) {
    const inZone = new Map<number, number>();
    for (let i = 0; i < CELLS; i++) {
      if (zmap[i] === z) inZone.set(target[i]!, (inZone.get(target[i]!) ?? 0) + 1);
    }
    const ranked = [...inZone.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    let keep = ranked.filter(([, c]) => c >= MIN_ZONE_COVER).slice(0, MAX_ZONE_HUES);
    // A zone must never collapse to one hue: that is a solid fill with the
    // generator's blessing.
    if (keep.length < 2) keep = ranked.slice(0, Math.min(2, ranked.length));
    if (keep.length === ranked.length) continue;

    const kept = new Set(keep.map(([h]) => h));
    const fallback = keep[0]![0];
    for (let i = 0; i < CELLS; i++) {
      if (zmap[i] !== z || kept.has(target[i]!)) continue;
      const alt = nearby(target, zmap, i, (h) => kept.has(h));
      target[i] = alt >= 0 ? alt : fallback;
    }
  }
}

/**
 * Guarantee every zone permits at least two hues.
 *
 * A single-hue zone is a zone law that says "fill this region with Grape",
 * which is a solid fill the generator has blessed — no deduction, and the
 * coverage floor cannot bite because there is nothing to balance it against.
 * The base generator samples 2-4 hues per zone but smooth noise can still land
 * entirely inside one band of a small zone, so the case is real rather than
 * hypothetical. Injecting a second hue on one parity is the cheapest fix that
 * also leaves a derivable law behind.
 */
function ensureZoneVariety(rng: Rng, target: Grid, zmap: Uint8Array, nz: number): void {
  const board = new Set<number>();
  for (let i = 0; i < CELLS; i++) board.add(target[i]!);

  for (let z = 0; z < nz; z++) {
    const inZone = new Set<number>();
    const cells: number[] = [];
    for (let i = 0; i < CELLS; i++) {
      if (zmap[i] !== z) continue;
      inZone.add(target[i]!);
      cells.push(i);
    }
    if (inZone.size >= 2) continue;

    const options = [...board].filter((h) => !inZone.has(h));
    const s = options.length ? rng.pick(options) : (target[cells[0]!]! + 1) % HUE_COUNT;
    const p = rng.int(2);
    const density = 0.15 + rng.next() * 0.1;
    let placed = 0;
    for (const i of cells) {
      if (((i % GRID) + ((i / GRID) | 0)) % 2 !== p) continue;
      if (rng.next() < density) {
        target[i] = s;
        placed++;
      }
    }
    // A zone too small for the sprinkle to clear the coverage floor gets a
    // deterministic stripe instead, so the invariant holds for every scheme.
    if (placed < MIN_ZONE_COVER) {
      for (let k = 0; k < cells.length && placed < MIN_ZONE_COVER; k += 2) {
        const i = cells[k]!;
        if (target[i] === s) continue;
        target[i] = s;
        placed++;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Law derivation                                                      */
/* ------------------------------------------------------------------ */

function holds(rule: Rule, target: Grid, zmap: Uint8Array): boolean {
  return evaluateRule(rule, target, makeCtx(target, zmap)).status === "ok";
}

/** Two laws about the same hue (or hue pair) read as padding. One per topic. */
function ruleTopic(r: Rule): string {
  if (r.t === "zone") return `z${r.zone}`;
  const hues = "b" in r ? [r.a, (r as { b: number }).b].sort((x, y) => x - y) : [r.a];
  return `h${hues.join(",")}`;
}

/** True when `b` adds nothing on top of `a`, because `a` already implies it. */
function redundant(a: Rule, b: Rule): boolean {
  if (a.t === "farApart" && b.t === "forbidAdj") {
    return (a.a === b.a && a.b === b.b) || (a.a === b.b && a.b === b.a);
  }
  if (a.t === "parity" && (b.t === "lonely" || b.t === "noBlock")) return a.a === b.a;
  if (a.t === "lonely" && b.t === "noBlock") return a.a === b.a;
  return false;
}

/**
 * The no-thought fill family, re-derived per zone palette. Independent of the
 * generator's own decoy set on purpose — sharing it would grade a dialect by
 * the very check it optimises against.
 */
function cheapFills(zmap: Uint8Array, palettes: number[][]): Grid[] {
  const patterns: ((x: number, y: number) => number)[] = [
    () => 0,
    (x, y) => x + y,
    (x, y) => y,
    (x, y) => x,
    (x, y) => (x >> 1) + (y >> 1),
    (x, y) => (x + y) >> 2,
    (x, y) => y >> 2,
    (x, y) => x >> 2,
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

function harden(
  rng: Rng,
  live: Rule[],
  extras: Rule[],
  valid: Rule[],
  takenTopics: Set<string>,
  zmap: Uint8Array,
  palettes: number[][],
): boolean {
  const decoys = cheapFills(zmap, palettes).map((g) => ({ g, ctx: makeCtx(g, zmap) }));
  for (let round = 0; round < 8; round++) {
    const survivors = decoys.filter(({ g, ctx }) =>
      live.every((r) => evaluateRule(r, g, ctx).status === "ok"),
    );
    if (!survivors.length) return true;

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
        if (kills === survivors.length) break;
      }
    }
    if (!best) return false;
    takenTopics.add(ruleTopic(best));
    extras.push(best);
    live.push(best);
  }
  return false;
}

/**
 * Same shape as the generator's derivation, with every threshold jittered by
 * the dialect. The jitter is what stops a solver from carrying a memorised
 * "Mint covers at least 340 cells" across runs: the law survives, the number
 * does not.
 */
function deriveDialectRules(
  rng: Rng,
  target: Grid,
  zmap: Uint8Array,
  nz: number,
  tier: number,
): { rules: Rule[]; resists: boolean } {
  const counts = new Int32Array(HUE_COUNT);
  for (let i = 0; i < CELLS; i++) counts[target[i]!]!++;
  const used = [...Array(HUE_COUNT).keys()].filter((h) => counts[h]! > 0);

  const floorFactor = rng.pick([0.4, 0.5, 0.6]);
  const zoneRules: Rule[] = [];
  const palettes: number[][] = [];
  for (let z = 0; z < nz; z++) {
    const inZone = new Map<number, number>();
    for (let i = 0; i < CELLS; i++) {
      if (zmap[i] === z) inZone.set(target[i]!, (inZone.get(target[i]!) ?? 0) + 1);
    }
    const hues = [...inZone.keys()].sort((a, b) => a - b);
    const scarcest = Math.min(...hues.map((h) => inZone.get(h)!));
    palettes.push(hues);
    // Never above `scarcest`, or the reference solution fails its own law.
    zoneRules.push({
      t: "zone",
      zone: z,
      hues,
      each: Math.min(scarcest, Math.max(2, Math.floor(scarcest * floorFactor))),
    });
  }

  const quotaMaxSlack = rng.pick([1.08, 1.18, 1.3]);
  const quotaMinFrac = rng.pick([0.45, 0.55, 0.65]);
  const lineSlack = rng.pick([1, 2, 3]);

  const candidates: Rule[] = [];
  for (let i = 0; i < used.length; i++) {
    for (let j = i + 1; j < used.length; j++) {
      const a = used[i]!;
      const b = used[j]!;
      candidates.push({ t: "forbidAdj", a, b });
      candidates.push({ t: "farApart", a, b });
      candidates.push({ t: "requireAdj", a, b });
      candidates.push({ t: "requireAdj", a: b, b: a });
    }
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
    const c = counts[a]!;
    if (c >= 40) {
      candidates.push({ t: "quotaMax", a, max: Math.min(CELLS, Math.round(c * quotaMaxSlack) + 12) });
      candidates.push({ t: "quotaMin", a, min: Math.max(1, Math.round(c * quotaMinFrac)) });
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
        candidates.push({ t: "lineLimit", a, axis, max: Math.min(GRID, worst + lineSlack) });
      }
    }
  }

  const valid = candidates.filter((r) => holds(r, target, zmap));

  const byKind = new Map<string, Rule[]>();
  for (const r of valid) {
    const list = byKind.get(r.t) ?? [];
    list.push(r);
    byKind.set(r.t, list);
  }
  for (const list of byKind.values()) rng.shuffle(list);

  const nExtra = [2, 3, 4, 5][tier]!;
  const extras: Rule[] = [];
  const takenTopics = new Set<string>();
  const take = (r: Rule): boolean => {
    const topic = ruleTopic(r);
    if (takenTopics.has(topic)) return false;
    takenTopics.add(topic);
    extras.push(r);
    return true;
  };

  for (const k of rng.shuffle([...byKind.keys()])) {
    if (extras.length >= nExtra) break;
    for (const r of byKind.get(k)!) if (take(r)) break;
  }
  for (const r of rng.shuffle([...byKind.values()].flat())) {
    if (extras.length >= nExtra) break;
    take(r);
  }

  const resists = harden(rng, [...zoneRules, ...extras], extras, valid, takenTopics, zmap, palettes);
  return { rules: [...zoneRules, ...extras], resists };
}

const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

function pickBonds(rng: Rng, target: Grid, rules: Rule[]): Bond[] {
  const banned = new Set<string>();
  for (const r of rules) {
    if (r.t === "forbidAdj" || r.t === "farApart") banned.add(pairKey(r.a, r.b));
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

/* ------------------------------------------------------------------ */
/* Public entry points                                                 */
/* ------------------------------------------------------------------ */

const cache = new Map<string, { puzzle: Puzzle; target: Grid }>();

/**
 * The dialect's puzzle for `key`. Deterministic in (salt, key), and memoised —
 * every feedback round trip re-derives this, so it has to be free after the
 * first call.
 */
export function dialectPuzzle(salt: string, key: string): { puzzle: Puzzle; target: Grid } {
  const id = `${salt}|${key}`;
  const hit = cache.get(id);
  if (hit) return hit;

  const base = generate(key);
  const scheme = base.puzzle.scheme;
  const zmap = zoneMap(scheme);
  const nz = zoneCount(scheme);
  const tier = tierFor(key);
  const perm = huePermutation(rngFor(salt, key, "perm"));

  // A dialect can perturb a board into one no true law separates from a
  // mechanical fill, exactly as the generator's own redraw loop can. Re-plant
  // and try again rather than ship it; the attempt counter feeds the seed, so
  // this stays deterministic.
  let target!: Grid;
  let rules!: Rule[];
  for (let attempt = 0; ; attempt++) {
    const tag = attempt === 0 ? "" : `#${attempt}`;
    target = new Int8Array(CELLS);
    for (let i = 0; i < CELLS; i++) target[i] = perm[base.target[i]!]!;
    replant(rngFor(salt, key, `plant${tag}`), target, zmap, nz);
    tidyZones(target, zmap, nz);
    ensureZoneVariety(rngFor(salt, key, `vary${tag}`), target, zmap, nz);
    const derived = deriveDialectRules(rngFor(salt, key, `laws${tag}`), target, zmap, nz, tier);
    rules = derived.rules;
    if (derived.resists || attempt >= 5) break;
  }

  const bonds = pickBonds(rngFor(salt, key, "bonds"), target, rules);
  const { points, difficulty } = pointsFor(rules);

  const puzzle: Puzzle = {
    key,
    // Deliberately not the salt. `Puzzle` reaches the share page after a solve,
    // and a salt on that page would hand out every other board in the run.
    seed: `pixe-dialect/${DIALECT_VERSION}:${key}`,
    title: base.puzzle.title,
    scheme,
    rules,
    bonds,
    points,
    difficulty,
    hueSet: [...new Set(Array.from(target))].sort((a, b) => a - b),
    parBonds: countBonds(target, bonds),
  };

  const out = { puzzle, target };
  if (cache.size > 512) cache.clear();
  cache.set(id, out);
  return out;
}

/**
 * The dialect's answer to `assess`. Same evaluation path, same feedback
 * channels — this is the function the server calls both to score a submission
 * and to answer a feedback request, so a submission can never be accepted under
 * different laws than the ones the glow was reporting on.
 */
export function assessDialect(salt: string, key: string, grid: Grid): Assessment {
  const { puzzle } = dialectPuzzle(salt, key);
  const zmap = zoneMap(puzzle.scheme);
  const ctx = makeCtx(grid, zmap);

  const evals: RuleEval[] = [];
  const badCells = new Set<number>();
  const hotHues = new Set<number>();
  let allOk = true;

  for (const rule of puzzle.rules) {
    const ev = evaluateRule(rule, grid, ctx);
    evals.push(ev);
    if (ev.status === "ok") continue;
    allOk = false;
    for (const c of ev.violations) badCells.add(c);
    if (ev.hue !== null) hotHues.add(ev.hue);
  }

  return {
    puzzle,
    evals,
    badCells,
    hotHues,
    filled: CELLS - ctx.empties,
    empty: ctx.empties,
    bonds: countBonds(grid, puzzle.bonds),
    solved: ctx.empties === 0 && allOk,
  };
}
