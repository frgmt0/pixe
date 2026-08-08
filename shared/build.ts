/**
 * Building the reference solution, and planting structure into it.
 *
 * This module owns the half of generation that happens *before* any law
 * exists. It is shared by the base generator and by the per-run dialect,
 * because the two used to be near-identical copies and the copies drifted.
 *
 * Nothing here can make a puzzle unsolvable. Every function is a grid edit; the
 * laws are read off whatever grid comes out the other end (`shared/laws.ts`),
 * so a plant that half-works, or that a later plant partly undoes, costs the
 * puzzle a law and never costs it a solution. That asymmetry is what lets the
 * planting menu be aggressive.
 */

import { CELLS, GRID, HUE_COUNT } from "./palette";
import type { Rng } from "./prng";
import { forEachRun, latticeIndex, reflect, type Grid } from "./rules";
import type { ZoneScheme } from "./zones";
import { zoneCount, zoneMap } from "./zones";

/** A hue below this in a zone is noise, not a colour the zone is "about". */
export const MIN_ZONE_COVER = 10;
/** Zone palettes wider than this stop constraining anything. */
export const MAX_ZONE_HUES = 4;

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
/* Zone schemes                                                        */
/* ------------------------------------------------------------------ */

const EASY_SCHEMES: ZoneScheme[] = [
  { kind: "quadrants" },
  { kind: "bands", axis: "h", n: 2 },
  { kind: "bands", axis: "v", n: 2 },
  { kind: "bands", axis: "h", n: 3 },
  { kind: "bands", axis: "v", n: 3 },
];

const SPICY_SCHEMES: ZoneScheme[] = [
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

export function pickScheme(rng: Rng, tier: number): ZoneScheme {
  if (tier === 0) return rng.pick(EASY_SCHEMES);
  if (tier === 1) return rng.pick(rng.bool(0.7) ? EASY_SCHEMES : SPICY_SCHEMES);
  if (tier >= 4) return rng.pick(rng.bool(0.15) ? EASY_SCHEMES : SPICY_SCHEMES);
  return rng.pick(rng.bool(0.3) ? EASY_SCHEMES : SPICY_SCHEMES);
}

/* ------------------------------------------------------------------ */
/* The reference solution                                              */
/* ------------------------------------------------------------------ */

/**
 * Paint a reference solution: a per-zone palette sampled from a global hue set,
 * shaded by two octaves of value noise so regions come out blobby rather than
 * confetti. Blobby is what makes adjacency laws derivable at all.
 */
export function buildBoard(rng: Rng, scheme: ZoneScheme, tier: number): { target: Grid; zmap: Uint8Array } {
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
  return { target, zmap };
}

/* ------------------------------------------------------------------ */
/* Grid edits                                                          */
/* ------------------------------------------------------------------ */

/**
 * The nearest hue to cell `i`, inside the same zone, that `ok` accepts.
 *
 * Reaching for a neighbour rather than a random substitute is what keeps
 * regions blobby whenever a plant evicts a colour, and blobby is what makes
 * adjacency laws derivable at all.
 */
export function nearbyHue(
  target: Grid,
  zmap: Uint8Array,
  i: number,
  ok: (h: number) => boolean,
): number {
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
  // Zone was entirely the hue being evicted; anything else on the board will do.
  for (let j = 0; j < CELLS; j++) {
    const v = target[j]!;
    if (v >= 0 && ok(v)) return v;
  }
  return -1;
}

/** Repaint every cell where `hit` says the hue must go, keeping `locked` intact. */
export function evict(
  target: Grid,
  zmap: Uint8Array,
  hue: number,
  hit: (i: number) => boolean,
  locked?: Uint8Array,
): void {
  for (let i = 0; i < CELLS; i++) {
    if (target[i] !== hue || !hit(i)) continue;
    if (locked?.[i]) continue;
    const alt = nearbyHue(target, zmap, i, (h) => h !== hue);
    target[i] = alt >= 0 ? alt : (hue + 1) % HUE_COUNT;
  }
}

/* ------------------------------------------------------------------ */
/* The planting menu                                                   */
/* ------------------------------------------------------------------ */

/**
 * Deliberately plant structure the derivation step can find.
 *
 * Smooth noise never happens to satisfy a parity, a modular stripe or a
 * symmetry by accident, so without this the law set could only ever contain
 * zone, adjacency and quota laws — exactly the twelve primitives the board
 * shipped with. Every entry here exists to make one of the newer families
 * *true*, so that reading laws off the reference solution finds it.
 *
 * Plants may conflict: symmetrising a hue can break the parity class a previous
 * plant gave it. That is fine and deliberate. Laws are read off the finished
 * grid, so a spoilt plant costs a law and never costs a solution.
 */
export type Plant = (rng: Rng, target: Grid, zmap: Uint8Array, nz: number, hues: number[]) => void;

/**
 * Scatter one hue onto same-parity cells inside a few zones.
 *
 * Same-parity cells are never orthogonally adjacent, so this one move makes
 * parity, lonely, noBlock, knight and a tight quota all derivable at once.
 */
export const plantParity: Plant = (rng, target, zmap, nz, hues) => {
  const s = rng.pick(hues);
  const p = rng.int(2);
  const zones = new Set(rng.sample([...Array(nz).keys()], Math.max(1, Math.ceil(nz / 2))));
  const density = 0.07 + rng.next() * 0.1;
  for (let i = 0; i < CELLS; i++) {
    if ((((i % GRID) + ((i / GRID) | 0)) & 1) !== p) continue;
    if (!zones.has(zmap[i]!)) continue;
    if (rng.next() < density) target[i] = s;
  }
  evict(target, zmap, s, (i) => (((i % GRID) + ((i / GRID) | 0)) & 1) !== p);
};

/**
 * The same idea one dimension out: confine a hue to a modular class of a linear
 * index. `parity` is the k = 2 diagonal case; k = 3, 4 or 5 on any of four axes
 * is a far larger hypothesis space and looks nothing like a checkerboard.
 */
export const plantLattice: Plant = (rng, target, zmap, nz, hues) => {
  const s = rng.pick(hues);
  const axis = rng.pick(["sum", "diff", "x", "y"] as const);
  const k = rng.range(3, 5);
  const r = rng.int(k);
  const zones = new Set(rng.sample([...Array(nz).keys()], Math.max(1, Math.ceil(nz / 2))));
  const density = 0.14 + rng.next() * 0.16;
  for (let i = 0; i < CELLS; i++) {
    if (latticeIndex(axis, i % GRID, (i / GRID) | 0) % k !== r) continue;
    if (!zones.has(zmap[i]!)) continue;
    if (rng.next() < density) target[i] = s;
  }
  evict(target, zmap, s, (i) => latticeIndex(axis, i % GRID, (i / GRID) | 0) % k !== r);
};

/** Evict a hue from the outer band, so a `border` law becomes true. */
export const plantBorderBan: Plant = (rng, target, zmap, _nz, hues) => {
  if (hues.length <= 2) return;
  const b = rng.pick(hues);
  const d = rng.range(2, 5);
  evict(target, zmap, b, (i) => Math.min(i % GRID, (i / GRID) | 0, GRID - 1 - (i % GRID), GRID - 1 - ((i / GRID) | 0)) < d);
};

/**
 * Evict a hue from every cell whose x × y falls in one residue class.
 *
 * The evicted set has no shape: the multiplication table mod k is dense near
 * the axes and sparse in the middle, and looks like nothing at all. An agent
 * staring at those flashes has no geometric hypothesis to reach for.
 */
export const plantProductBan: Plant = (rng, target, zmap, _nz, hues) => {
  if (hues.length <= 2) return;
  const a = rng.pick(hues);
  const k = rng.range(3, 6);
  const r = rng.int(k);
  evict(target, zmap, a, (i) => ((i % GRID) * ((i / GRID) | 0)) % k === r);
};

/**
 * Make one hue's cell set invariant under an involution, by taking the union of
 * the set with its image. Union rather than intersection because `op(S ∪ op S)`
 * is `op S ∪ S` for any involution — symmetric by construction, with none of
 * the erosion an intersection would cause.
 */
export const plantMirror: Plant = (rng, target, zmap, _nz, hues) => {
  if (hues.length <= 2) return;
  const a = rng.pick(hues);
  const op = rng.pick(["rot180", "flipX", "flipY", "transpose"] as const);
  const add: number[] = [];
  for (let i = 0; i < CELLS; i++) if (target[i] === a) add.push(reflect(op, i));
  for (const j of add) target[j] = a;
  void zmap;
};

/** Delete every island of a hue that cannot walk to the frame through itself. */
export const plantReach: Plant = (rng, target, zmap, _nz, hues) => {
  if (hues.length <= 2) return;
  const a = rng.pick(hues);
  const seen = new Uint8Array(CELLS);
  const stack: number[] = [];
  for (let s = 0; s < CELLS; s++) {
    if (seen[s] || target[s] !== a) continue;
    const cells: number[] = [];
    let border = false;
    seen[s] = 1;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      cells.push(i);
      const x = i % GRID;
      const y = (i / GRID) | 0;
      if (x === 0 || y === 0 || x === GRID - 1 || y === GRID - 1) border = true;
      if (x > 0 && target[i - 1] === a && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < GRID - 1 && target[i + 1] === a && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (i >= GRID && target[i - GRID] === a && !seen[i - GRID]) { seen[i - GRID] = 1; stack.push(i - GRID); }
      if (i + GRID < CELLS && target[i + GRID] === a && !seen[i + GRID]) { seen[i + GRID] = 1; stack.push(i + GRID); }
    }
    if (border) continue;
    const doomed = new Set(cells);
    evict(target, zmap, a, (i) => doomed.has(i));
  }
};

/** Pull every row (or column) that holds both hues down to holding one. */
export const plantExclusive: Plant = (rng, target, zmap, _nz, hues) => {
  if (hues.length <= 3) return;
  const [a, b] = rng.sample(hues, 2) as [number, number];
  const axis = rng.pick(["row", "col"] as const);
  const line = (i: number) => (axis === "row" ? (i / GRID) | 0 : i % GRID);
  const na = new Int32Array(GRID);
  const nb = new Int32Array(GRID);
  for (let i = 0; i < CELLS; i++) {
    if (target[i] === a) na[line(i)]!++;
    else if (target[i] === b) nb[line(i)]!++;
  }
  // Evict whichever of the two is the guest in each contested line, so the
  // plant costs the board as little paint as possible.
  const dropA = new Uint8Array(GRID);
  const dropB = new Uint8Array(GRID);
  for (let l = 0; l < GRID; l++) {
    if (!na[l] || !nb[l]) continue;
    if (na[l]! <= nb[l]!) dropA[l] = 1;
    else dropB[l] = 1;
  }
  evict(target, zmap, a, (i) => dropA[line(i)] === 1);
  evict(target, zmap, b, (i) => dropB[line(i)] === 1);
};

/** Trim every run of one hue down to a multiple of `m`, along one axis. */
export const plantRunMod: Plant = (rng, target, zmap, _nz, hues) => {
  if (hues.length <= 2) return;
  const a = rng.pick(hues);
  const axis = rng.pick(["row", "col"] as const);
  const m = rng.bool(0.7) ? 2 : 3;
  const doomed = new Set<number>();
  forEachRun(target, a, axis, (cells) => {
    const over = cells.length % m;
    // Shortening a run from its tail cannot merge it with another run: the
    // cells between two runs are, by definition, not this hue.
    for (let k = 0; k < over; k++) doomed.add(cells[cells.length - 1 - k]!);
  });
  evict(target, zmap, a, (i) => doomed.has(i));
};

/** Thin a hue until no two of them stand a knight's move apart. */
export const plantKnight: Plant = (rng, target, zmap, _nz, hues) => {
  if (hues.length <= 2) return;
  const a = rng.pick(hues);
  const moves: [number, number][] = [[1, 2], [2, 1], [2, -1], [1, -2]];
  const doomed = new Set<number>();
  for (let i = 0; i < CELLS; i++) {
    if (target[i] !== a || doomed.has(i)) continue;
    const x = i % GRID;
    const y = (i / GRID) | 0;
    for (const [dx, dy] of moves) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
      const j = ny * GRID + nx;
      if (target[j] === a && !doomed.has(j)) doomed.add(j);
    }
  }
  evict(target, zmap, a, (i) => doomed.has(i));
};

/**
 * The menu, and how much of it each tier gets.
 *
 * Early rungs get the two plants the board always had, so an opening puzzle is
 * exactly as hard as it used to be. The exotic plants come in from tier 2 and
 * the count climbs with the tier, which is the mechanism behind the whole
 * difficulty curve: more planted structure means more exotic laws are true of
 * the reference solution and therefore available to be selected.
 */
const CLASSIC_PLANTS: Plant[] = [plantParity, plantBorderBan];
const EXOTIC_PLANTS: Plant[] = [
  plantLattice,
  plantProductBan,
  plantMirror,
  plantReach,
  plantExclusive,
  plantRunMod,
  plantKnight,
];

/** How many plants a tier lands on the board. Index is the tier, 0..5. */
export const PLANTS_PER_TIER = [1, 2, 4, 5, 7, 9];

export function plantStructure(rng: Rng, target: Grid, zmap: Uint8Array, nz: number, tier: number): void {
  const present = (): number[] => {
    const seen = new Set<number>();
    for (let i = 0; i < CELLS; i++) seen.add(target[i]!);
    return [...seen].sort((a, b) => a - b);
  };

  const n = PLANTS_PER_TIER[Math.min(tier, PLANTS_PER_TIER.length - 1)]!;
  const pool = tier <= 1 ? [...CLASSIC_PLANTS] : [...CLASSIC_PLANTS, ...EXOTIC_PLANTS];
  // Classics first so the parity sprinkle is never crowded out; the exotic
  // ones are drawn without replacement so no plant runs twice.
  const chosen = [
    ...CLASSIC_PLANTS.slice(0, Math.min(n, CLASSIC_PLANTS.length)),
    ...rng.sample(pool.filter((p) => !CLASSIC_PLANTS.includes(p)), Math.max(0, n - CLASSIC_PLANTS.length)),
  ];
  for (const plant of rng.shuffle(chosen)) plant(rng, target, zmap, nz, present());
}

/* ------------------------------------------------------------------ */
/* Tidying                                                             */
/* ------------------------------------------------------------------ */

/**
 * Absorb hues that hold no real ground in a zone, and cap how wide a zone
 * palette may get. Both directions matter: a thin trace turns the coverage
 * floor back into a token cell, and a zone that permits six of eight hues
 * permits everything.
 *
 * `protect` names hues that must survive whatever their count — the hues sitting
 * on pre-filled locked cells, which cannot be repainted and must therefore stay
 * legal where they are.
 */
export function tidyZones(
  target: Grid,
  zmap: Uint8Array,
  nz: number,
  protect?: (zone: number, hue: number) => boolean,
): void {
  for (let z = 0; z < nz; z++) {
    const inZone = new Map<number, number>();
    for (let i = 0; i < CELLS; i++) {
      if (zmap[i] === z) inZone.set(target[i]!, (inZone.get(target[i]!) ?? 0) + 1);
    }
    const ranked = [...inZone.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const forced = ranked.filter(([h]) => protect?.(z, h));
    const strong = ranked
      .filter(([h, c]) => c >= MIN_ZONE_COVER && !protect?.(z, h))
      .slice(0, Math.max(1, MAX_ZONE_HUES - forced.length));
    let keep = [...forced, ...strong];
    // Never top a thin hue back up to reach two. A zone law naming a colour
    // that covers nine cells is a coverage floor of two, which is the
    // token-cell loophole the floor exists to close — and a zone left with one
    // hue is not left that way: `ensureZoneVariety` runs next and injects a
    // second one with real ground under it.
    if (keep.length === 0) keep = ranked.slice(0, 1);
    if (keep.length === ranked.length) continue;

    const kept = new Set(keep.map(([h]) => h));
    const fallback = keep[0]![0];
    for (let i = 0; i < CELLS; i++) {
      if (zmap[i] !== z || kept.has(target[i]!)) continue;
      if (protect?.(z, target[i]!)) continue;
      const alt = nearbyHue(target, zmap, i, (h) => kept.has(h));
      target[i] = alt >= 0 ? alt : fallback;
    }
  }
}

/**
 * Guarantee every zone permits at least two hues, and that every hue it permits
 * holds real ground.
 *
 * A single-hue zone is a zone law that says "fill this region with Grape",
 * which is a solid fill the generator has blessed — no deduction, and the
 * coverage floor cannot bite because there is nothing to balance it against.
 */
export function ensureZoneVariety(
  rng: Rng,
  target: Grid,
  zmap: Uint8Array,
  nz: number,
  locked?: Uint8Array,
): void {
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
      if (locked?.[i]) continue;
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
        if (locked?.[i] || target[i] === s) continue;
        target[i] = s;
        placed++;
      }
    }
  }
}

/**
 * Grow a hue inside one zone until it holds at least `want` cells there.
 *
 * Used after locked cells are stamped into a later phase's reference solution:
 * a carried-over colour that lands in a zone it is otherwise absent from would
 * make that zone's coverage floor a single token cell, which is the loophole
 * the floor exists to close.
 */
export function growInZone(
  target: Grid,
  zmap: Uint8Array,
  zone: number,
  hue: number,
  want: number,
  locked: Uint8Array,
): void {
  const cells: number[] = [];
  let have = 0;
  for (let i = 0; i < CELLS; i++) {
    if (zmap[i] !== zone) continue;
    if (target[i] === hue) have++;
    else cells.push(i);
  }
  if (have >= want) return;
  // Nearest-first, measured from the cells already carrying the hue, so the
  // growth stays a blob rather than a spray.
  const seeds: number[] = [];
  for (let i = 0; i < CELLS; i++) if (zmap[i] === zone && target[i] === hue) seeds.push(i);
  const anchor = seeds.length ? seeds[0]! : cells[0]!;
  const ax = anchor % GRID;
  const ay = (anchor / GRID) | 0;
  cells.sort(
    (p, q) =>
      Math.abs((p % GRID) - ax) + Math.abs(((p / GRID) | 0) - ay) -
      (Math.abs((q % GRID) - ax) + Math.abs(((q / GRID) | 0) - ay)),
  );
  for (const i of cells) {
    if (have >= want) break;
    if (locked[i]) continue;
    target[i] = hue;
    have++;
  }
}
