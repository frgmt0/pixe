/**
 * Multi-phase rungs.
 *
 * A rung deep in the ladder is not one board but a short chain of them. The
 * server issues phase 1; accepting phase k hands back phase k+1 in the same
 * response, on the same clock, and the rung banks only when the last phase is
 * accepted. Nothing about phase k+1 exists until phase k has been solved,
 * because phase k+1's laws are *derived from the agent's own accepted grid*.
 *
 * ## Why the derivation is safe
 *
 * The generator's sacred invariant is that the reference solution is built
 * first and the laws are read back off it, which is the only reason a solution
 * provably exists. A derived constraint threatens that directly: a quota
 * computed from someone else's grid has no reason to be satisfiable by a board
 * we drew independently.
 *
 * So no derived constraint is ever *imposed*. Every one of them is expressed as
 * an edit to phase k+1's reference solution, applied before a single law is
 * derived:
 *
 *   - "the hue you used most is banned from zone z"  →  evict it from zone z,
 *     and the zone law derived afterwards simply does not list it.
 *   - "that hue may cover at most N cells"           →  trim it below N, then
 *     state the quota the trim guarantees.
 *   - "your rarest hue must cover at least M"        →  grow it past M first.
 *   - "these cells are carried over"                 →  stamp them in.
 *
 * The reference solution therefore satisfies every derived law by construction,
 * exactly as it satisfies every other law, and it satisfies them *for any legal
 * phase-k grid* — the stamp is unconditional and the numeric bounds are clamped
 * into ranges an edit can always reach. That is the proof, and
 * `shared/phases.test.ts` runs it against real accepted grids.
 *
 * A law that somehow fails the check anyway is dropped rather than shipped, so
 * the worst case is a slightly weaker board, never an unwinnable one.
 */

import { evict, growInZone, MIN_ZONE_COVER, nearbyHue } from "./build";
import { encodeGrid } from "./codec";
import type { LockedCell } from "./generate";
import { holds } from "./laws";
import { CELLS, GRID, HUE_COUNT } from "./palette";
import { Rng, hashString } from "./prng";
import type { Grid, Rule } from "./rules";

/** Cells carried over, as clusters. Small and few, so a zone palette that has
 *  to widen to accommodate them widens by one or two hues and not by five. */
const CARRY_CLUSTERS = 4;
const CARRY_SIDE = 2;

/**
 * Every number phase k+1 takes from the agent's phase-k answer.
 *
 * A pure function of (salt, key, phase, the accepted grids). Re-deriving it
 * from the seed and the stored grids reproduces it exactly, which is what lets
 * the server re-validate a phase months later with nothing but its database.
 */
export interface PhaseHandoff {
  /** Digest of the accepted grids so far, folded to a u32. Seeds everything. */
  tag: number;
  /** The hue the agent leaned on hardest last phase. It gets punished. */
  topHue: number;
  /** The hue it used least. It gets promoted. */
  rareHue: number;
  /** Ceiling for `topHue`, and floor for `rareHue`, both already clamped. */
  cap: number;
  floor: number;
  /** Cells to hand back pre-filled, with the values the agent painted them. */
  carry: LockedCell[];
}

/**
 * Bounds the derived quotas are clamped into.
 *
 * The clamp is not cosmetic. `cap` has to leave room for a board that still
 * has three or four other hues on it, and `floor` has to be something a grow
 * pass can reach without flooding a zone. Outside these the derivation would be
 * asking for a board the builder cannot draw, which is exactly the failure mode
 * the whole module exists to avoid.
 */
const CAP_MIN = 90;
const CAP_MAX = 900;
const FLOOR_MIN = 45;
const FLOOR_MAX = 520;

export function handoffFor(salt: string, key: string, phase: number, priors: Grid[]): PhaseHandoff {
  const last = priors[priors.length - 1]!;
  const tag = hashString(priors.map(encodeGrid).join("|"));
  const rng = new Rng(hashString(`pixe-phase/1:${salt}:${key}:${phase}:${tag}`));

  const counts = new Int32Array(HUE_COUNT);
  for (let i = 0; i < CELLS; i++) counts[last[i]!]!++;
  let topHue = 0;
  let rareHue = -1;
  for (let h = 0; h < HUE_COUNT; h++) {
    if (counts[h]! > counts[topHue]!) topHue = h;
    if (counts[h]! > 0 && (rareHue < 0 || counts[h]! < counts[rareHue]!)) rareHue = h;
  }
  if (rareHue < 0 || rareHue === topHue) rareHue = (topHue + 1) % HUE_COUNT;

  const cap = clamp(Math.round(counts[topHue]! * 0.55), CAP_MIN, CAP_MAX);
  const floor = clamp(Math.round(Math.max(counts[rareHue]!, 60) * 1.1), FLOOR_MIN, FLOOR_MAX);

  const carry: LockedCell[] = [];
  const taken = new Set<number>();
  for (let c = 0; c < CARRY_CLUSTERS; c++) {
    const x0 = rng.range(2, GRID - 2 - CARRY_SIDE);
    const y0 = rng.range(2, GRID - 2 - CARRY_SIDE);
    for (let dy = 0; dy < CARRY_SIDE; dy++) {
      for (let dx = 0; dx < CARRY_SIDE; dx++) {
        const i = (y0 + dy) * GRID + x0 + dx;
        if (taken.has(i)) continue;
        taken.add(i);
        carry.push({ x: x0 + dx, y: y0 + dy, hue: last[i]! });
      }
    }
  }
  return { tag, topHue, rareHue, cap, floor, carry };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/* ------------------------------------------------------------------ */
/* Applying a handoff to a phase's reference solution                   */
/* ------------------------------------------------------------------ */

export interface PhaseMutation {
  locked: Uint8Array;
  forced: Rule[];
  after: (target: Grid, zmap: Uint8Array, nz: number) => Rule[];
}

/**
 * Fold a handoff into a freshly built reference solution.
 *
 * Runs in two halves because tidying runs between them. The first half stamps
 * the carried cells and bans a hue from a zone — both structural, and both
 * things the zone laws must be derived *after*. The second half enforces the
 * two numeric bounds, and runs after tidying precisely because tidying moves
 * counts around and would otherwise undo them.
 */
export function applyHandoff(h: PhaseHandoff, target: Grid, zmap: Uint8Array, nz: number): PhaseMutation {
  // --- The zone ban. Deterministic in the handoff, and expressed as an
  // eviction so the zone law derived later simply never lists the hue.
  const bannedZone = h.tag % nz;
  evict(target, zmap, h.topHue, (i) => zmap[i] === bannedZone);

  // --- The carry. Stamped unconditionally, which is what makes phase k+1
  // solvable for *any* legal phase-k grid rather than for the ones we like.
  const locked = new Uint8Array(CELLS);
  for (const { x, y, hue } of h.carry) {
    const i = y * GRID + x;
    target[i] = hue;
    locked[i] = 1;
  }

  // --- A carried colour that lands somewhere it is otherwise absent would give
  // that zone a coverage floor of one cell, which is the token-cell loophole the
  // floor exists to close. Grow it to real ground instead.
  const wanted = new Map<string, { zone: number; hue: number }>();
  for (let i = 0; i < CELLS; i++) {
    if (locked[i]) wanted.set(`${zmap[i]}:${target[i]}`, { zone: zmap[i]!, hue: target[i]! });
  }
  for (const { zone, hue } of wanted.values()) {
    growInZone(target, zmap, zone, hue, MIN_ZONE_COVER + 4, locked);
  }

  const lockedRule: Rule = {
    t: "locked",
    cells: h.carry.map(({ x, y, hue }) => ({ i: y * GRID + x, h: hue })),
  };

  return {
    locked,
    forced: [lockedRule],
    after: (t, zm) => {
      trimTo(t, zm, h.topHue, h.cap - h.carry.length, locked);
      growTo(t, zm, h.rareHue, h.floor, locked);
      const derived: Rule[] = [
        { t: "quotaMax", a: h.topHue, max: h.cap },
        { t: "quotaMin", a: h.rareHue, min: h.floor },
      ];
      // The bounds were reached by construction, but tidying and variety passes
      // run in between, so this is checked rather than assumed. A bound that no
      // longer holds is dropped: a weaker board, never an unwinnable one.
      return derived.filter((r) => holds(r, t, zm));
    },
  };
}

/** Repaint cells of `hue` until at most `want` of them remain. */
function trimTo(target: Grid, zmap: Uint8Array, hue: number, want: number, locked: Uint8Array): void {
  let have = 0;
  for (let i = 0; i < CELLS; i++) if (target[i] === hue) have++;
  if (have <= want) return;
  // Walk with a stride that is coprime to the cell count, so the cells that go
  // are spread over the whole board rather than shaved off the top rows.
  const stride = 1597;
  for (let n = 0, i = 0; n < CELLS && have > want; n++, i = (i + stride) % CELLS) {
    if (target[i] !== hue || locked[i]) continue;
    const alt = nearbyHue(target, zmap, i, (x) => x !== hue);
    if (alt < 0) continue;
    target[i] = alt;
    have--;
  }
}

/** Paint cells until at least `want` of `hue` exist, growing from where it is. */
function growTo(target: Grid, zmap: Uint8Array, hue: number, want: number, locked: Uint8Array): void {
  let have = 0;
  const perZone = new Map<number, number>();
  for (let i = 0; i < CELLS; i++) {
    if (target[i] !== hue) continue;
    have++;
    perZone.set(zmap[i]!, (perZone.get(zmap[i]!) ?? 0) + 1);
  }
  if (have >= want) return;
  // Grow inside whichever zone already holds most of the hue, so the addition
  // reads as the colour spreading rather than as confetti in a new region.
  const home = [...perZone.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  growInZone(target, zmap, home, hue, (perZone.get(home) ?? 0) + (want - have), locked);

  // A single zone may not be big enough. Spill into the rest, nearest first.
  have = 0;
  for (let i = 0; i < CELLS; i++) if (target[i] === hue) have++;
  if (have >= want) return;
  const stride = 1597;
  for (let n = 0, i = 0; n < CELLS && have < want; n++, i = (i + stride) % CELLS) {
    if (target[i] === hue || locked[i]) continue;
    target[i] = hue;
    have++;
  }
}
