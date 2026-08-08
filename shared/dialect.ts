/**
 * Per-run rule dialects, and the phase chain a rung is made of.
 *
 * Two runs handed the same ladder key must not be playing the same board. The
 * ladder is only a few hundred keys wide and a run's key stream is public the
 * moment it is issued, so without this a solver that has seen L412 once could
 * recognise it forever, and boards would transfer between runs the way they
 * transferred between puzzles before the chained sequence existed.
 *
 * The generator's load-bearing invariant is that the reference solution is
 * built first and the laws are read back off it, which is the only reason a
 * solution provably exists. A dialect must not touch that ordering, so it hooks
 * in exactly where the generator does: it perturbs the *reference solution*,
 * then re-derives every law against the perturbed grid.
 *
 * Phase 1 of a rung is the base board for its key, relabelled and re-planted.
 * Phases 2 and 3 are fresh boards — their own zone scheme, their own noise —
 * built under constraints derived from the agent's accepted grid for the phase
 * before. `shared/phases.ts` is where those derivations live and why they are
 * safe; everything here is the plumbing that runs them.
 */

import { ensureZoneVariety, plantParity, plantStructure, tidyZones } from "./build";
import { encodeGrid } from "./codec";
import {
  composeBoard, countBonds, generate, lawsFor, phaseCountFor, pickBonds, pointsFor, tierFor,
  titleFor, type LockedCell, type Puzzle,
} from "./generate";
import { DEFAULT_OPTS, type DeriveOpts } from "./laws";
import { applyHandoff, handoffFor } from "./phases";
import { CELLS, HUE_COUNT } from "./palette";
import { Rng, hashString } from "./prng";
import {
  buzzedHues, evaluateRule, makeCtx, type Bond, type Grid, type Rule, type RuleEval,
} from "./rules";
import { zoneCount, zoneMap } from "./zones";
import type { Assessment } from "./validate";

/**
 * Bumping this invalidates every stored dialect. Runs in flight would break.
 *
 * 2 is the twenty-six-primitive law set and the phase chain.
 */
export const DIALECT_VERSION = 2;

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
 * One PRNG per stage rather than one per puzzle, so a change to how laws are
 * picked cannot silently re-roll the board the laws are picked from.
 */
function rngFor(salt: string, key: string, tag: string): Rng {
  return new Rng(hashString(`pixe-dialect/${DIALECT_VERSION}:${salt}:${key}:${tag}`));
}

/**
 * Every numeric threshold, jittered by the dialect. The jitter is what stops a
 * solver from carrying a memorised "Mint covers at least 340 cells" across
 * runs: the law survives, the number does not.
 */
function optsFor(salt: string, key: string, phase: number, tier: number): DeriveOpts {
  const rng = rngFor(salt, key, `opts:${phase}`);
  return {
    ...DEFAULT_OPTS,
    tier,
    floorFactor: rng.pick([0.4, 0.5, 0.6]),
    quotaMaxSlack: rng.pick([1.08, 1.18, 1.3]),
    quotaMinFrac: rng.pick([0.45, 0.55, 0.65]),
    lineSlack: rng.pick([1, 2, 3]),
    boxSlack: rng.pick([1, 2]),
    runSlack: rng.pick([1, 2]),
  };
}

/* ------------------------------------------------------------------ */
/* Perturbing the reference solution                                   */
/* ------------------------------------------------------------------ */

/** Every hue on the board right now. Plants are keyed to what is present. */
function present(target: Grid): number[] {
  const seen = new Set<number>();
  for (let i = 0; i < CELLS; i++) seen.add(target[i]!);
  return [...seen].sort((a, b) => a - b);
}

function huePermutation(rng: Rng): number[] {
  return rng.shuffle([...Array(HUE_COUNT).keys()]);
}

/**
 * Per-zone palette permutation.
 *
 * The global permutation is a single secret: recover it once from one solved
 * board and it explains every other board in the run. A permutation chosen
 * independently per zone is not expressible as one global relabelling, so
 * recovering it in one region says nothing about the next.
 */
function permuteZones(rng: Rng, target: Grid, zmap: Uint8Array, nz: number): void {
  for (let z = 0; z < nz; z++) {
    const inZone = new Set<number>();
    for (let i = 0; i < CELLS; i++) if (zmap[i] === z) inZone.add(target[i]!);
    const hues = [...inZone].sort((a, b) => a - b);
    if (hues.length < 2) continue;
    const shuffled = rng.shuffle(hues.slice());
    const map = new Map(hues.map((h, k) => [h, shuffled[k]!]));
    for (let i = 0; i < CELLS; i++) if (zmap[i] === z) target[i] = map.get(target[i]!)!;
  }
}

/** Zone-local hue swaps: two runs can share a hue permutation and still
 *  disagree about which colour owns which region. */
function swapInZones(rng: Rng, target: Grid, zmap: Uint8Array, nz: number): void {
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

/* ------------------------------------------------------------------ */
/* Building one phase                                                  */
/* ------------------------------------------------------------------ */

export interface PhaseBoard {
  puzzle: Puzzle;
  target: Grid;
}

const cache = new Map<string, PhaseBoard>();

/**
 * The dialect's board for one phase of one rung.
 *
 * `priors` are the accepted grids for the phases before this one, in order.
 * Deterministic in (salt, key, phase, priors) — which is the whole re-validation
 * contract: the server stores the accepted grids and can rebuild any phase of
 * any rung from the seed and those grids alone.
 */
export function dialectPhase(salt: string, key: string, phase: number, priors: Grid[] = []): PhaseBoard {
  const tag = priors.length ? hashString(priors.map(encodeGrid).join("|")) : 0;
  const id = `${salt}|${key}|${phase}|${tag}`;
  const hit = cache.get(id);
  if (hit) return hit;

  const tier = tierFor(key);
  const phases = phaseCountFor(key);
  const opts = optsFor(salt, key, phase, tier);
  const built = phase <= 1 ? firstPhase(salt, key, tier, opts) : laterPhase(salt, key, phase, tier, opts, priors);

  const bonds: Bond[] = pickBonds(rngFor(salt, key, `bonds:${phase}:${tag}`), built.target, built.rules);
  const { points, difficulty } = pointsFor(built.rules);
  const locked: LockedCell[] = [];
  for (const r of built.rules) {
    if (r.t !== "locked") continue;
    for (const c of r.cells) locked.push({ x: c.i % 64, y: (c.i / 64) | 0, hue: c.h });
  }

  const puzzle: Puzzle = {
    key,
    // Deliberately not the salt. `Puzzle` reaches the share page after a solve,
    // and a salt on that page would hand out every other board in the run.
    seed: `pixe-dialect/${DIALECT_VERSION}:${key}:${phase}`,
    title: built.title,
    scheme: built.scheme,
    rules: built.rules,
    bonds,
    points,
    difficulty,
    hueSet: [...new Set(Array.from(built.target))].sort((a, b) => a - b),
    parBonds: countBonds(built.target, bonds),
    phase: Math.max(1, phase),
    phases,
    locked,
  };

  const out: PhaseBoard = { puzzle, target: built.target };
  if (cache.size > 512) cache.clear();
  cache.set(id, out);
  return out;
}

interface Built {
  scheme: Puzzle["scheme"];
  target: Grid;
  rules: Rule[];
  title: string;
}

/**
 * Phase 1: the ladder key's own board, relabelled and re-planted.
 *
 * The key still decides the zone geometry and the underlying noise field, which
 * is what makes `L412` a name for something; the salt decides everything else.
 */
function firstPhase(salt: string, key: string, tier: number, opts: DeriveOpts): Built {
  const base = generate(key);
  const scheme = base.puzzle.scheme;
  const zmap = zoneMap(scheme);
  const nz = zoneCount(scheme);
  const perm = huePermutation(rngFor(salt, key, "perm"));

  // A dialect can perturb a board into one no true law separates from a
  // mechanical fill, exactly as the generator's own redraw loop can. Re-plant
  // and try again rather than ship it; the attempt counter feeds the seed, so
  // this stays deterministic.
  let target!: Grid;
  let rules!: Rule[];
  for (let attempt = 0; ; attempt++) {
    const t = attempt === 0 ? "" : `#${attempt}`;
    target = new Int8Array(CELLS);
    for (let i = 0; i < CELLS; i++) target[i] = perm[base.target[i]!]!;
    const rng = rngFor(salt, key, `plant${t}`);
    permuteZones(rng, target, zmap, nz);
    // Always, on top of whatever the tier's planting menu draws. It is the one
    // perturbation that rewrites cell *content* rather than relabelling it, and
    // content is what a stolen grid consists of — a run that only ever permuted
    // hues would be handing every other run a board it could recolour.
    plantParity(rng, target, zmap, nz, present(target));
    plantStructure(rng, target, zmap, nz, tier);
    swapInZones(rng, target, zmap, nz);
    tidyZones(target, zmap, nz);
    ensureZoneVariety(rng, target, zmap, nz);
    const derived = lawsFor(rngFor(salt, key, `laws${t}`), target, zmap, nz, opts);
    rules = derived.rules;
    if (derived.resists || attempt >= 5) break;
  }
  return { scheme, target, rules, title: base.puzzle.title };
}

/**
 * Phase 2 and 3: a fresh board, built under constraints derived from the
 * agent's own accepted grid for the phase before.
 *
 * A new zone scheme every phase, deliberately. Half the work of a board is
 * finding its geometry, and a phase that reused the last one's would be a
 * discount on the part of the puzzle that is most legible.
 */
function laterPhase(
  salt: string,
  key: string,
  phase: number,
  tier: number,
  opts: DeriveOpts,
  priors: Grid[],
): Built {
  const handoff = handoffFor(salt, key, phase, priors);
  let built!: ReturnType<typeof composeBoard>;
  for (let attempt = 0; ; attempt++) {
    const t = attempt === 0 ? "" : `#${attempt}`;
    const rng = rngFor(salt, key, `phase:${phase}:${handoff.tag}${t}`);
    built = composeBoard(rng, tier, opts, (target, zmap, nz) => applyHandoff(handoff, target, zmap, nz));
    if (built.resists || attempt >= 4) break;
  }
  return {
    scheme: built.scheme,
    target: built.target,
    rules: built.rules,
    title: titleFor(rngFor(salt, key, `title:${phase}:${handoff.tag}`)),
  };
}

/** Phase 1 of a rung — what `/next` issues, and the shape everything else had. */
export function dialectPuzzle(salt: string, key: string): PhaseBoard {
  return dialectPhase(salt, key, 1, []);
}

/* ------------------------------------------------------------------ */
/* Assessment                                                          */
/* ------------------------------------------------------------------ */

/**
 * The dialect's answer to `assess`. Same evaluation path, same feedback
 * channels — this is the function the server calls both to score a submission
 * and to answer a feedback request, so a submission can never be accepted under
 * different laws than the ones the flashes were reporting on.
 */
export function assessPhase(
  salt: string,
  key: string,
  phase: number,
  priors: Grid[],
  grid: Grid,
): Assessment {
  const { puzzle } = dialectPhase(salt, key, phase, priors);
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
    for (const h of buzzedHues(ev)) hotHues.add(h);
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

export function assessDialect(salt: string, key: string, grid: Grid): Assessment {
  return assessPhase(salt, key, 1, [], grid);
}
