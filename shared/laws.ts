/**
 * Reading the laws back off a finished reference solution.
 *
 * This is the half of generation that happens *after* the board exists, and it
 * is shared by the base generator and by every per-run dialect so the two
 * cannot drift.
 *
 * The load-bearing property is that nothing here invents a constraint. Every
 * candidate is *computed* from the target rather than guessed and filtered:
 * `runCap` is emitted with the target's own longest run plus slack, `regions`
 * with the number of islands the target actually has, `countMod` with the
 * residue the target's own count lands on. A law that is true of the reference
 * solution is a law the reference solution satisfies, so a solution provably
 * exists, and it exists for exactly the same reason it always did.
 *
 * Computing rather than filtering is also what keeps this affordable. Twenty-six
 * primitives across eight hues and four axes is thousands of hypotheses; testing
 * each one against 4096 cells would cost tens of milliseconds per board, and a
 * board is derived on every probe.
 */

import { CELLS, GRID, HUE_COUNT } from "./palette";
import type { Rng } from "./prng";
import {
  components,
  evaluateRule,
  forEachRun,
  latticeIndex,
  makeCtx,
  reflect,
  type Grid,
  ruleWeight,
  type Rule,
} from "./rules";

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

/**
 * Thresholds a law must clear to be worth stating.
 *
 * A law about a hue covering nine cells is vacuously true of almost any grid
 * and teaches nothing: `knight` on a hue that appears three times is not a
 * constraint, it is a coincidence. Every exotic family therefore has a floor on
 * how much ground its hue must hold.
 */
const MIN_FOR_GEOMETRY = 30;
const MIN_FOR_TOPOLOGY = 45;
const MIN_FOR_ARITHMETIC = 60;

export interface DeriveOpts {
  /** 0-5. Gates which families are enumerated at all. */
  tier: number;
  /** Every numeric threshold is jittered per dialect so no number transfers. */
  quotaMaxSlack: number;
  quotaMinFrac: number;
  lineSlack: number;
  boxSlack: number;
  runSlack: number;
  /** The zone coverage floor, as a fraction of the zone's scarcest hue. */
  floorFactor: number;
}

export const DEFAULT_OPTS: DeriveOpts = {
  tier: 3,
  quotaMaxSlack: 1.18,
  quotaMinFrac: 0.55,
  lineSlack: 2,
  boxSlack: 1,
  runSlack: 1,
  floorFactor: 0.5,
};

/** Tier at which the families beyond the original twelve become available. */
export const EXOTIC_TIER = 2;
/** Tier at which the arithmetic families — the ones with no visible shape. */
export const ARITHMETIC_TIER = 3;

/* ------------------------------------------------------------------ */
/* Zone laws                                                           */
/* ------------------------------------------------------------------ */

/**
 * Zone laws, read straight off the reference solution.
 *
 * `each` turns the permit list into a requirement list: every listed hue has to
 * cover real ground here. That is what forces the whole palette onto the board,
 * which in turn is what stops the hue-keyed laws below from being dodged into
 * vacuous truth by simply never painting the hue they name. It is derived from
 * the scarcest hue in the zone and then scaled down, so the reference solution
 * clears it with room to spare and the player is never asked to match a number.
 */
export function deriveZoneRules(
  target: Grid,
  zmap: Uint8Array,
  nz: number,
  floorFactor: number,
): { zoneRules: Rule[]; palettes: number[][] } {
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
    // Never above `scarcest`, or the reference solution would fail its own law;
    // never below 2 unless the target genuinely leaves no room, because a floor
    // of 1 is the token-cell loophole all over again.
    zoneRules.push({
      t: "zone",
      zone: z,
      hues,
      each: Math.min(scarcest, Math.max(2, Math.floor(scarcest * floorFactor))),
    });
  }
  return { zoneRules, palettes };
}

/* ------------------------------------------------------------------ */
/* Candidate derivation                                                */
/* ------------------------------------------------------------------ */

/**
 * Every law that is true of `target`, worth stating, and permitted at this tier.
 *
 * The result is a menu, not a rule set — `selectRules` picks from it. Anything
 * returned here is guaranteed satisfied by `target`, and `assertHold` in the
 * tests re-checks that guarantee through the ordinary evaluator rather than
 * trusting the arithmetic below.
 */
export function deriveCandidates(
  target: Grid,
  zmap: Uint8Array,
  nz: number,
  opts: DeriveOpts,
): Rule[] {
  const out: Rule[] = [];
  const counts = new Int32Array(HUE_COUNT);
  for (let i = 0; i < CELLS; i++) counts[target[i]!]!++;
  const used = [...Array(HUE_COUNT).keys()].filter((h) => counts[h]! > 0);
  const exotic = opts.tier >= EXOTIC_TIER;
  const arithmetic = opts.tier >= ARITHMETIC_TIER;

  /* --- pairwise adjacency, in two passes over the board ------------- */
  const H = HUE_COUNT;
  const adj4 = new Uint8Array(H * H);
  const adj8 = new Uint8Array(H * H);
  // `need[a]` is a bitmask of the hues that EVERY a has orthogonally beside it.
  const need = new Int32Array(H).fill(-1);
  const rowMask = new Int32Array(GRID);
  const colMask = new Int32Array(GRID);

  for (let i = 0; i < CELLS; i++) {
    const v = target[i]!;
    const x = i % GRID;
    const y = (i / GRID) | 0;
    rowMask[y]! |= 1 << v;
    colMask[x]! |= 1 << v;

    let mask = 0;
    if (x > 0) { const u = target[i - 1]!; adj4[v * H + u] = adj4[u * H + v] = 1; mask |= 1 << u; }
    if (x < GRID - 1) { const u = target[i + 1]!; adj4[v * H + u] = adj4[u * H + v] = 1; mask |= 1 << u; }
    if (y > 0) { const u = target[i - GRID]!; adj4[v * H + u] = adj4[u * H + v] = 1; mask |= 1 << u; }
    if (y < GRID - 1) { const u = target[i + GRID]!; adj4[v * H + u] = adj4[u * H + v] = 1; mask |= 1 << u; }
    need[v]! &= mask;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
        const u = target[ny * GRID + nx]!;
        adj8[v * H + u] = adj8[u * H + v] = 1;
      }
    }
  }

  for (let i = 0; i < used.length; i++) {
    for (let j = i + 1; j < used.length; j++) {
      const a = used[i]!;
      const b = used[j]!;
      if (!adj4[a * H + b]) out.push({ t: "forbidAdj", a, b });
      if (!adj8[a * H + b]) out.push({ t: "farApart", a, b });
      if (need[a]! & (1 << b)) out.push({ t: "requireAdj", a, b });
      if (need[b]! & (1 << a)) out.push({ t: "requireAdj", a: b, b: a });
      if (exotic && counts[a]! >= MIN_FOR_GEOMETRY && counts[b]! >= MIN_FOR_GEOMETRY) {
        for (const axis of ["row", "col"] as const) {
          const mask = axis === "row" ? rowMask : colMask;
          let clash = false;
          for (let l = 0; l < GRID; l++) {
            if (mask[l]! & (1 << a) && mask[l]! & (1 << b)) clash = true;
          }
          if (!clash) out.push({ t: "exclusive", a, b, axis });
        }
      }
      // A ratio between two totals, stated so that the reference solution
      // clears it: the bound is the true ratio rounded the safe way.
      if (exotic && counts[a]! >= MIN_FOR_ARITHMETIC && counts[b]! >= MIN_FOR_ARITHMETIC) {
        const lo = Math.floor((counts[a]! * 10) / counts[b]!);
        if (lo >= 5 && lo <= 45) out.push({ t: "relCount", a, b, tenths: lo, cmp: "atLeast" });
        const hi = Math.ceil((counts[a]! * 10) / counts[b]!);
        if (hi >= 5 && hi <= 45) out.push({ t: "relCount", a, b, tenths: hi, cmp: "atMost" });
      }
    }
  }

  /* --- per-zone tallies, once ---------------------------------------- */
  const zoneHue = new Int32Array(nz * H);
  const zoneSize = new Int32Array(nz);
  for (let i = 0; i < CELLS; i++) {
    const z = zmap[i]!;
    zoneSize[z]!++;
    zoneHue[z * H + target[i]!]!++;
  }

  /* --- whole-board arithmetic, one pass per hypothesis, not per hue --
   *
   * A residue histogram over eight hues costs the same single sweep as one
   * over a single hue, and there are ninety-odd hypotheses here. Sweeping per
   * hue instead would be an eight-fold cost on the hottest code in generation.
   */
  const latticeSeen = new Map<string, Int32Array>();
  const productSeen = new Map<number, Int32Array>();
  const knightClash = new Uint8Array(H);
  const mirrorOk = new Map<string, Uint8Array>();
  if (arithmetic) {
    for (const axis of ["sum", "diff", "x", "y"] as const) {
      for (const k of [3, 4, 5]) {
        const seen = new Int32Array(H);
        for (let i = 0; i < CELLS; i++) {
          seen[target[i]!]! |= 1 << (latticeIndex(axis, i % GRID, (i / GRID) | 0) % k);
        }
        latticeSeen.set(`${axis}:${k}`, seen);
      }
    }
    for (const k of [3, 4, 5, 6]) {
      const seen = new Int32Array(H);
      for (let i = 0; i < CELLS; i++) seen[target[i]!]! |= 1 << (((i % GRID) * ((i / GRID) | 0)) % k);
      productSeen.set(k, seen);
    }
  }
  if (exotic) {
    const moves: [number, number][] = [[1, 2], [2, 1], [2, -1], [1, -2]];
    for (let i = 0; i < CELLS; i++) {
      const v = target[i]!;
      if (knightClash[v]) continue;
      const x = i % GRID;
      const y = (i / GRID) | 0;
      for (const [dx, dy] of moves) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
        if (target[ny * GRID + nx] === v) { knightClash[v] = 1; break; }
      }
    }
    for (const op of ["rot180", "flipX", "flipY", "transpose"] as const) {
      const okHue = new Uint8Array(H).fill(1);
      for (let i = 0; i < CELLS; i++) {
        const v = target[i]!;
        if (target[reflect(op, i)] !== v) okHue[v] = 0;
      }
      mirrorOk.set(op, okHue);
    }
  }

  /* --- per-hue families -------------------------------------------- */
  for (const a of used) {
    const c = counts[a]!;
    if (need[a]! & (1 << a)) out.push({ t: "buddy", a });
    if (!adj4[a * H + a]) out.push({ t: "lonely", a });

    let blocky = false;
    for (let y = 0; y < GRID - 1 && !blocky; y++) {
      for (let x = 0; x < GRID - 1; x++) {
        const i = y * GRID + x;
        if (target[i] === a && target[i + 1] === a && target[i + GRID] === a && target[i + GRID + 1] === a) {
          blocky = true;
          break;
        }
      }
    }
    if (!blocky) out.push({ t: "noBlock", a });

    // Border band: the shallowest and deepest this hue ever gets.
    let minDepth = GRID;
    let maxDepth = -1;
    const rowTally = new Int32Array(GRID);
    const colTally = new Int32Array(GRID);
    const half = { h: [0, 0], v: [0, 0] };
    for (let i = 0; i < CELLS; i++) {
      if (target[i] !== a) continue;
      const x = i % GRID;
      const y = (i / GRID) | 0;
      const d = Math.min(x, y, GRID - 1 - x, GRID - 1 - y);
      if (d < minDepth) minDepth = d;
      if (d > maxDepth) maxDepth = d;
      rowTally[y]!++;
      colTally[x]!++;
      half.h[y < GRID / 2 ? 0 : 1]!++;
      half.v[x < GRID / 2 ? 0 : 1]!++;
    }
    for (const d of [2, 3, 4, 5]) {
      if (minDepth >= d) out.push({ t: "border", a, mode: "never", d });
      if (maxDepth >= 0 && maxDepth < d) out.push({ t: "border", a, mode: "only", d });
    }

    if (c >= 40) {
      out.push({ t: "quotaMax", a, max: Math.min(CELLS, Math.round(c * opts.quotaMaxSlack) + 12) });
      out.push({ t: "quotaMin", a, min: Math.max(1, Math.round(c * opts.quotaMinFrac)) });
    }
    let rowWorst = 0;
    let colWorst = 0;
    for (let l = 0; l < GRID; l++) {
      if (rowTally[l]! > rowWorst) rowWorst = rowTally[l]!;
      if (colTally[l]! > colWorst) colWorst = colTally[l]!;
    }
    if (rowWorst > 0 && rowWorst < GRID - 6) {
      out.push({ t: "lineLimit", a, axis: "row", max: Math.min(GRID, rowWorst + opts.lineSlack) });
    }
    if (colWorst > 0 && colWorst < GRID - 6) {
      out.push({ t: "lineLimit", a, axis: "col", max: Math.min(GRID, colWorst + opts.lineSlack) });
    }

    /* --- coordinate arithmetic ------------------------------------- */
    // Parity is the k = 2 diagonal case of `lattice`, kept as its own primitive
    // because it is the hypothesis an agent reaches for first and should stay
    // cheap. Available at every tier: it is one of the original twelve.
    {
      let evens = 0;
      let odds = 0;
      for (let i = 0; i < CELLS; i++) {
        if (target[i] !== a) continue;
        if (((i % GRID) + ((i / GRID) | 0)) & 1) odds++;
        else evens++;
      }
      if (evens && !odds) out.push({ t: "parity", a, p: 0 });
      if (odds && !evens) out.push({ t: "parity", a, p: 1 });
    }
    // The residue histograms were built above, once for the whole board. A
    // `lattice` law holds exactly when the whole hue lives in one class, so
    // there is nothing left to test here.
    if (arithmetic && c >= MIN_FOR_ARITHMETIC) {
      for (const axis of ["sum", "diff", "x", "y"] as const) {
        for (const k of [3, 4, 5]) {
          const seen = latticeSeen.get(`${axis}:${k}`)![a]!;
          // Exactly one bit set: a power of two, and non-zero.
          if (seen && (seen & (seen - 1)) === 0) {
            out.push({ t: "lattice", a, axis, k, r: Math.round(Math.log2(seen)) });
          }
        }
      }
      for (const k of [3, 4, 5, 6]) {
        const seen = productSeen.get(k)![a]!;
        for (let r = 0; r < k; r++) {
          if (!(seen & (1 << r))) out.push({ t: "product", a, k, r });
        }
      }
      for (const m of [2, 3]) out.push({ t: "countMod", a, m, r: c % m });
    }

    if (!exotic || c < MIN_FOR_GEOMETRY) continue;

    /* --- extended adjacency ---------------------------------------- */
    if (!knightClash[a]) out.push({ t: "knight", a });
    for (const r of [1, 2]) {
      const side = 2 * r + 1;
      const w = GRID + 1;
      const sum = new Int32Array(w * w);
      for (let y = 0; y < GRID; y++) {
        for (let x = 0; x < GRID; x++) {
          sum[(y + 1) * w + x + 1] =
            (target[y * GRID + x] === a ? 1 : 0) +
            sum[y * w + x + 1]! + sum[(y + 1) * w + x]! - sum[y * w + x]!;
        }
      }
      let worst = 0;
      for (let y = 0; y + side <= GRID; y++) {
        for (let x = 0; x + side <= GRID; x++) {
          const n =
            sum[(y + side) * w + x + side]! - sum[y * w + x + side]! -
            sum[(y + side) * w + x]! + sum[y * w + x]!;
          if (n > worst) worst = n;
        }
      }
      // A cap at the window's own size constrains nothing.
      if (worst > 0 && worst + opts.boxSlack < side * side) {
        out.push({ t: "boxCap", a, r, max: worst + opts.boxSlack });
      }
    }

    /* --- runs ------------------------------------------------------- */
    for (const axis of ["row", "col"] as const) {
      let longest = 0;
      let g = 0;
      forEachRun(target, a, axis, (cells) => {
        if (cells.length > longest) longest = cells.length;
        g = gcd(g, cells.length);
      });
      if (longest > 0 && longest + opts.runSlack < GRID / 2) {
        out.push({ t: "runCap", a, axis, max: longest + opts.runSlack });
      }
      // A run law is only interesting when the divisor is not 1, and a hue
      // whose runs are all length 1 is already covered by `lonely`.
      for (const m of [2, 3]) {
        if (g > 0 && g % m === 0) out.push({ t: "runMod", a, axis, m });
      }
    }

    /* --- connectivity ---------------------------------------------- */
    if (c >= MIN_FOR_TOPOLOGY) {
      const comps = components(target, a);
      if (comps.length && comps.every((k) => k.touchesBorder)) out.push({ t: "reach", a });
      if (comps.length >= 1 && comps.length <= 8) out.push({ t: "regions", a, k: comps.length });
    }

    /* --- symmetry --------------------------------------------------- */
    if (c >= MIN_FOR_TOPOLOGY) {
      for (const op of ["rot180", "flipX", "flipY", "transpose"] as const) {
        if (mirrorOk.get(op)![a]) out.push({ t: "mirror", a, op });
      }
    }

    /* --- positional counting ---------------------------------------- */
    for (const axis of ["h", "v"] as const) {
      const sides = axis === "h" ? half.h : half.v;
      const heavy: 0 | 1 = sides[0]! >= sides[1]! ? 0 : 1;
      const diff = Math.abs(sides[0]! - sides[1]!);
      const margin = Math.floor(diff * 0.6);
      if (margin >= 20) out.push({ t: "halfTilt", a, axis, heavy, margin });
    }
    for (let z = 0; z < nz; z++) {
      const inZone = zoneHue[z * H + a]!;
      const size = zoneSize[z]!;
      if (inZone >= 25) out.push({ t: "zoneCount", a, zone: z, cmp: "atLeast", n: Math.floor(inZone * 0.7) });
      const capped = Math.ceil(inZone * 1.25) + 5;
      if (capped < size * 0.8) out.push({ t: "zoneCount", a, zone: z, cmp: "atMost", n: capped });
    }
  }

  return out;
}

function gcd(a: number, b: number): number {
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

/** Re-checks a derived law through the ordinary evaluator. Used by the tests. */
export function holds(rule: Rule, target: Grid, zmap: Uint8Array): boolean {
  return evaluateRule(rule, target, makeCtx(target, zmap)).status === "ok";
}

/* ------------------------------------------------------------------ */
/* Topics and implication                                              */
/* ------------------------------------------------------------------ */

/**
 * Two laws about the same hue (or the same hue pair) read as padding at the
 * bottom of the ladder, where a puzzle should be one idea at a time. Deep in
 * the ladder they are the point: three interlocking laws about Mint is exactly
 * the kind of board this benchmark is for. So the topic is a *budget* rather
 * than a ban — see `selectRules` — and genuine implication is filtered
 * separately by `redundant`, at every tier.
 */
export function ruleTopic(r: Rule): string {
  if (r.t === "zone") return `z${r.zone}`;
  if (r.t === "locked") return "locked";
  const hues = "b" in r ? [r.a, (r as { b: number }).b].sort((x, y) => x - y) : [r.a];
  return `h${hues.join(",")}`;
}

/** True when `b` adds nothing on top of `a`, because `a` already implies it. */
export function redundant(a: Rule, b: Rule): boolean {
  if (a.t === "farApart" && b.t === "forbidAdj") {
    return (a.a === b.a && a.b === b.b) || (a.a === b.b && a.b === b.a);
  }
  // A hue confined to one checkerboard parity can never touch itself, which
  // already gives you `lonely`; `lonely` already gives you `noBlock` and a
  // run cap of one; and a knight's move always flips the checkerboard colour,
  // so parity gives you `knight` for free as well.
  const parityLike =
    a.t === "parity" || (a.t === "lattice" && (a.axis === "sum" || a.axis === "diff") && a.k === 2);
  if (parityLike && (b.t === "lonely" || b.t === "noBlock" || b.t === "knight")) return a.a === b.a;
  if (parityLike && b.t === "runCap") return a.a === b.a && b.max <= 1;
  if (parityLike && b.t === "parity") return a.a === b.a;
  // Any diagonal modular stripe separates the hue from itself orthogonally.
  if (a.t === "lattice" && (a.axis === "sum" || a.axis === "diff")) {
    if (b.t === "lonely" || b.t === "noBlock") return a.a === b.a;
    if (b.t === "runCap") return a.a === b.a && b.max <= 1;
  }
  if (a.t === "lonely" && (b.t === "noBlock" || (b.t === "runCap" && b.max <= 1))) return a.a === b.a;
  // A hue that has to touch the frame is a hue with no interior island, which
  // is most of what a one-region law would have told you.
  if (a.t === "regions" && b.t === "regions") return a.a === b.a;
  if (a.t === "quotaMax" && b.t === "quotaMax") return a.a === b.a && a.max <= b.max;
  if (a.t === "quotaMin" && b.t === "quotaMin") return a.a === b.a && a.min >= b.min;
  if (a.t === "runMod" && b.t === "runMod") return a.a === b.a && a.axis === b.axis && b.m !== 0 && a.m % b.m === 0;
  return false;
}

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

/**
 * Pick a type-diverse subset of the menu.
 *
 * First pass takes one law of each kind, so a board is never five quotas.
 * Second pass tops up to `nExtra` from the whole pool. `maxPerTopic` is what
 * makes the upper ladder dense: at the bottom it is 1 and every law is about a
 * different colour, and by the top it is 3 and the colours interlock.
 */
export function selectRules(
  rng: Rng,
  candidates: Rule[],
  nExtra: number,
  maxPerTopic: number,
): { extras: Rule[]; topics: Map<string, number> } {
  const byKind = new Map<string, Rule[]>();
  for (const r of candidates) {
    const list = byKind.get(r.t) ?? [];
    list.push(r);
    byKind.set(r.t, list);
  }
  for (const list of byKind.values()) rng.shuffle(list);

  const extras: Rule[] = [];
  const topics = new Map<string, number>();
  const take = (r: Rule): boolean => {
    const topic = ruleTopic(r);
    if ((topics.get(topic) ?? 0) >= maxPerTopic) return false;
    if (extras.some((e) => redundant(e, r) || redundant(r, e))) return false;
    topics.set(topic, (topics.get(topic) ?? 0) + 1);
    extras.push(r);
    return true;
  };

  // Which kinds get first refusal. Deep in the ladder the heavy families go
  // first — a board allowed eleven laws should spend them on the ones that are
  // hard to see, not on the three cheapest quotas that happened to shuffle up.
  // The jitter is wide enough that the order is still unpredictable.
  const bias = maxPerTopic > 1 ? 1 : 0;
  const kinds = [...byKind.keys()].sort(
    (a, b) =>
      (ruleWeight(byKind.get(b)![0]!) - ruleWeight(byKind.get(a)![0]!)) * bias +
      (rng.next() - rng.next()) * 3,
  );

  for (const k of kinds) {
    if (extras.length >= nExtra) break;
    for (const r of byKind.get(k)!) if (take(r)) break;
  }
  for (const r of rng.shuffle([...byKind.values()].flat())) {
    if (extras.length >= nExtra) break;
    take(r);
  }
  return { extras, topics };
}

/* ------------------------------------------------------------------ */
/* Adversarial hardening                                               */
/* ------------------------------------------------------------------ */

/**
 * The no-thought fill family: grids that need no understanding of the puzzle.
 *
 * Each zone gets its own permitted palette cycled through a mechanical pattern,
 * which clears the zone laws and the coverage floor by construction — so
 * whatever rejects these has to be a real constraint.
 *
 * The three patterns past the original eight exist because the new families
 * changed which decoys are dangerous: a hue laid down on `x ^ y` satisfies a
 * surprising number of modular laws, and `x * y` satisfies `product` outright
 * for the wrong reason.
 */
export function cheapFills(zmap: Uint8Array, palettes: number[][]): Grid[] {
  const patterns: ((x: number, y: number) => number)[] = [
    () => 0,
    (x, y) => x + y,
    (x, y) => y,
    (x, y) => x,
    (x, y) => (x >> 1) + (y >> 1),
    (x, y) => (x + y) >> 2,
    (x, y) => y >> 2,
    (x, y) => x >> 2,
    (x, y) => x ^ y,
    (x, y) => x * y,
    (x, y) => (x * 3 + y * 5) >> 1,
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

/** How many candidates `harden` will weigh per round. Bounded so a rich menu
 *  cannot turn one board's generation into a hundred milliseconds. */
const HARDEN_POOL = 64;

/**
 * Adversarial pass: a puzzle must not fall to a strategy that involves no
 * deduction at all.
 *
 * The zone coverage floor killed solid fills, but the next thing anyone tries
 * is a mechanical pattern, and those are alarmingly good at constraint
 * satisfaction by accident — a checkerboard satisfies `lonely`, `noBlock`,
 * `parity` and `requireAdj` simultaneously. So rather than guess which laws are
 * pattern-hostile, we check: every cheap grid that still validates gets a law
 * added specifically to break it, chosen greedily for how many decoys it kills.
 *
 * This generalises. A newly discovered cheap strategy only has to be added to
 * `cheapFills` and every puzzle hardens against it automatically.
 */
export function harden(
  rng: Rng,
  live: Rule[],
  extras: Rule[],
  pool: Rule[],
  topics: Map<string, number>,
  zmap: Uint8Array,
  palettes: number[][],
  maxPerTopic: number,
): boolean {
  const decoys = cheapFills(zmap, palettes).map((g) => ({ g, ctx: makeCtx(g, zmap) }));

  for (let round = 0; round < 8; round++) {
    const survivors = decoys.filter(({ g, ctx }) =>
      live.every((r) => evaluateRule(r, g, ctx).status === "ok"),
    );
    if (!survivors.length) return true;

    // Topic budget is an aesthetic preference; resisting a no-thought solution
    // is not, so it wins the tie. Here an over-budget topic is allowed and only
    // genuine redundancy is filtered out.
    const usable = pool.filter(
      (r) =>
        (topics.get(ruleTopic(r)) ?? 0) < maxPerTopic ||
        live.every((e) => !redundant(e, r) && !redundant(r, e)),
    );
    const shortlist = rng.shuffle(usable).slice(0, HARDEN_POOL);
    let best: Rule | null = null;
    let bestKills = 0;
    for (const r of shortlist) {
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
    topics.set(ruleTopic(best), (topics.get(ruleTopic(best)) ?? 0) + 1);
    extras.push(best);
    live.push(best);
  }
  // Ran out of rounds with decoys still standing.
  return false;
}
