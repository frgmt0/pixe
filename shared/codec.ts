import { CELLS, EMPTY } from "./palette";
import { emptyGrid, type Grid } from "./rules";

/**
 * Run-length codec for a 4096-cell grid. Compact enough to live in a sqlite
 * text column and a share link, and cheap to validate: any malformed input
 * decodes to `null` rather than throwing.
 *
 * Format: repeated `<hueChar><runLength>`, where hueChar is lowercase a-i and
 * the run length is uppercase base36. Cases are disjoint so the stream is
 * unambiguous without separators. e.g. "a14b1F" = 40 Tomato, then 51 Tangerine.
 */
const CHARS = "abcdefghi"; // index 0..7 = hue, 8 = empty
const EMPTY_CHAR = 8;
const LEN_RE = /^[0-9A-Z]$/;

export function encodeGrid(grid: Grid): string {
  let out = "";
  let run = 0;
  let cur = grid[0]!;
  for (let i = 1; i <= CELLS; i++) {
    run++;
    if (i === CELLS || grid[i] !== cur) {
      out += CHARS[cur < 0 ? EMPTY_CHAR : cur] + run.toString(36).toUpperCase();
      if (i < CELLS) {
        cur = grid[i]!;
        run = 0;
      }
    }
  }
  return out;
}

export function decodeGrid(s: unknown): Grid | null {
  if (typeof s !== "string" || s.length === 0 || s.length > 40000) return null;
  const grid = emptyGrid();
  let at = 0;
  let i = 0;
  while (i < s.length) {
    const v = CHARS.indexOf(s[i]!);
    if (v < 0) return null;
    i++;
    const numStart = i;
    while (i < s.length && LEN_RE.test(s[i]!)) i++;
    if (i === numStart) return null;
    const len = parseInt(s.slice(numStart, i), 36);
    if (!Number.isFinite(len) || len <= 0 || at + len > CELLS) return null;
    grid.fill(v === EMPTY_CHAR ? EMPTY : v, at, at + len);
    at += len;
  }
  return at === CELLS ? grid : null;
}
