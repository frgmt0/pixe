import { GRID, CELLS } from "./palette";

/**
 * A zone scheme partitions the 64x64 grid into a handful of regions. Every
 * puzzle picks exactly one scheme; positional rules are then expressed per
 * zone rather than per cell (4096 per-cell rules would be undeducible).
 */
export type ZoneScheme =
  | { kind: "quadrants" }
  | { kind: "bands"; axis: "h" | "v"; n: number }
  | { kind: "rings"; n: number }
  | { kind: "diagonals"; n: number }
  | { kind: "checker"; block: number }
  | { kind: "bullseye" };

export const ZONE_SCHEME_KINDS = [
  "quadrants",
  "bands",
  "rings",
  "diagonals",
  "checker",
  "bullseye",
] as const;

export function zoneCount(s: ZoneScheme): number {
  switch (s.kind) {
    case "quadrants":
      return 4;
    case "bands":
      return s.n;
    case "rings":
      return s.n;
    case "diagonals":
      return s.n;
    case "checker":
      return 2;
    case "bullseye":
      return 3;
  }
}

export function zoneOf(s: ZoneScheme, x: number, y: number): number {
  switch (s.kind) {
    case "quadrants": {
      const h = GRID / 2;
      return (x >= h ? 1 : 0) + (y >= h ? 2 : 0);
    }
    case "bands": {
      const v = s.axis === "h" ? y : x;
      return Math.min(s.n - 1, Math.floor((v * s.n) / GRID));
    }
    case "rings": {
      // Chebyshev distance from the border, bucketed into n concentric rings.
      const d = Math.min(x, y, GRID - 1 - x, GRID - 1 - y);
      const maxD = GRID / 2;
      return Math.min(s.n - 1, Math.floor((d * s.n) / maxD));
    }
    case "diagonals": {
      const v = x + y;
      return Math.min(s.n - 1, Math.floor((v * s.n) / (2 * GRID - 1)));
    }
    case "checker": {
      const bx = Math.floor(x / s.block);
      const by = Math.floor(y / s.block);
      return (bx + by) & 1;
    }
    case "bullseye": {
      // Euclidean distance from centre, three bands.
      const cx = (GRID - 1) / 2;
      const cy = (GRID - 1) / 2;
      const d = Math.hypot(x - cx, y - cy) / (GRID / 2);
      return d < 0.34 ? 0 : d < 0.68 ? 1 : 2;
    }
  }
}

/** Precomputed zone id per cell — hot path, worth the 4KB. */
export function zoneMap(s: ZoneScheme): Uint8Array {
  const m = new Uint8Array(CELLS);
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) m[y * GRID + x] = zoneOf(s, x, y);
  }
  return m;
}

/** Human-readable name for a zone, used in rule cards. */
export function zoneLabel(s: ZoneScheme, z: number): string {
  switch (s.kind) {
    case "quadrants":
      return ["the top-left quarter", "the top-right quarter", "the bottom-left quarter", "the bottom-right quarter"][z]!;
    case "bands": {
      if (s.axis === "h") {
        if (s.n === 2) return ["the top half", "the bottom half"][z]!;
        if (s.n === 3) return ["the top stripe", "the middle stripe", "the bottom stripe"][z]!;
        return `horizontal stripe ${z + 1} of ${s.n} (top to bottom)`;
      }
      if (s.n === 2) return ["the left half", "the right half"][z]!;
      if (s.n === 3) return ["the left stripe", "the middle stripe", "the right stripe"][z]!;
      return `vertical stripe ${z + 1} of ${s.n} (left to right)`;
    }
    case "rings":
      return z === 0 ? "the outer ring" : z === s.n - 1 ? "the innermost ring" : `ring ${z + 1} from the edge`;
    case "diagonals":
      return `diagonal band ${z + 1} of ${s.n} (top-left to bottom-right)`;
    case "checker":
      return z === 0 ? `the "black" squares of the ${s.block}×${s.block} checkerboard` : `the "white" squares of the ${s.block}×${s.block} checkerboard`;
    case "bullseye":
      return ["the bullseye centre", "the middle ring", "the outer edge"][z]!;
  }
}

export function schemeLabel(s: ZoneScheme): string {
  switch (s.kind) {
    case "quadrants":
      return "Quadrants";
    case "bands":
      return s.axis === "h" ? `${s.n} horizontal stripes` : `${s.n} vertical stripes`;
    case "rings":
      return `${s.n} concentric rings`;
    case "diagonals":
      return `${s.n} diagonal bands`;
    case "checker":
      return `${s.block}×${s.block} checkerboard`;
    case "bullseye":
      return "Bullseye";
  }
}
