/** The rainbow. Eight hues, goofy names, fixed order — hue id IS the index. */

export const GRID = 64;
export const CELLS = GRID * GRID; // 4096
export const EMPTY = -1;

export interface Hue {
  id: number;
  /** Silly display name shown on swatches and in rule text. */
  name: string;
  hex: string;
  /** Slightly darker edge colour, used for swatch borders + violation rings. */
  dark: string;
  emoji: string;
}

export const HUES: readonly Hue[] = [
  { id: 0, name: "Tomato", hex: "#ff4d4d", dark: "#b31d1d", emoji: "🍅" },
  { id: 1, name: "Tangerine", hex: "#ff9838", dark: "#c25f06", emoji: "🍊" },
  { id: 2, name: "Banana", hex: "#ffdd3c", dark: "#c2a000", emoji: "🍌" },
  { id: 3, name: "Slime", hex: "#4fd76a", dark: "#1d8a34", emoji: "🦖" },
  { id: 4, name: "Mint", hex: "#3fdcd0", dark: "#0e9990", emoji: "🧊" },
  { id: 5, name: "Blueberry", hex: "#4a86ff", dark: "#134ac2", emoji: "🫐" },
  { id: 6, name: "Grape", hex: "#a05cff", dark: "#6416c9", emoji: "🍇" },
  { id: 7, name: "Bubblegum", hex: "#ff5fc0", dark: "#c11482", emoji: "🍬" },
];

export const HUE_COUNT = HUES.length;

export function hueName(id: number): string {
  return HUES[id]?.name ?? "???";
}

export function hueHex(id: number): string {
  return HUES[id]?.hex ?? "#1a1a24";
}

/** Packed RGB for fast canvas ImageData writes. */
export const HUE_RGB: readonly [number, number, number][] = HUES.map((h) => [
  parseInt(h.hex.slice(1, 3), 16),
  parseInt(h.hex.slice(3, 5), 16),
  parseInt(h.hex.slice(5, 7), 16),
]);

export const EMPTY_RGB: [number, number, number] = [26, 26, 36];

export function idx(x: number, y: number): number {
  return y * GRID + x;
}

export function xOf(i: number): number {
  return i % GRID;
}

export function yOf(i: number): number {
  return (i / GRID) | 0;
}
