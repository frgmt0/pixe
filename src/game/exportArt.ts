import { GRID, HUE_RGB, EMPTY_RGB } from "@shared/palette";
import type { Grid } from "@shared/rules";

/** Renders the grid to an offscreen canvas at native 64x64 resolution. */
function toTinyCanvas(grid: Grid): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = GRID;
  c.height = GRID;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(GRID, GRID);
  for (let i = 0; i < GRID * GRID; i++) {
    const v = grid[i]!;
    const rgb = v < 0 ? EMPTY_RGB : HUE_RGB[v]!;
    const o = i * 4;
    img.data[o] = rgb[0];
    img.data[o + 1] = rgb[1];
    img.data[o + 2] = rgb[2];
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export interface PosterOptions {
  title: string;
  author: string;
  subtitle: string;
}

/**
 * Builds the shareable poster: the artwork blown up with nearest-neighbour
 * scaling (so it stays crisp pixel art) on a framed card with a caption.
 */
export function renderPoster(grid: Grid, opts: PosterOptions): HTMLCanvasElement {
  const scale = 12; // 64 * 12 = 768px of artwork
  const art = GRID * scale;
  const pad = 48;
  const caption = 132;

  const c = document.createElement("canvas");
  c.width = art + pad * 2;
  c.height = art + pad + caption;
  const ctx = c.getContext("2d")!;

  ctx.fillStyle = "#fff6e9";
  ctx.fillRect(0, 0, c.width, c.height);

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(toTinyCanvas(grid), pad, pad, art, art);

  ctx.strokeStyle = "#17141f";
  ctx.lineWidth = 8;
  ctx.strokeRect(pad - 4, pad - 4, art + 8, art + 8);

  const baseline = pad + art + 52;
  ctx.fillStyle = "#17141f";
  ctx.textBaseline = "alphabetic";
  ctx.font = "600 40px Fredoka, ui-rounded, system-ui, sans-serif";
  ctx.fillText(truncate(ctx, opts.title, art), pad, baseline);

  ctx.font = "600 24px Nunito, system-ui, sans-serif";
  ctx.fillStyle = "#4a4358";
  ctx.fillText(truncate(ctx, `${opts.subtitle} · painted by ${opts.author}`, art - 110), pad, baseline + 34);

  ctx.font = "600 30px Fredoka, ui-rounded, system-ui, sans-serif";
  ctx.fillStyle = "#17141f";
  ctx.textAlign = "right";
  ctx.fillText("pixe", c.width - pad, baseline + 34);
  ctx.textAlign = "left";

  return c;
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 4 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

export async function downloadPoster(grid: Grid, opts: PosterOptions, filename: string): Promise<void> {
  const canvas = renderPoster(grid, opts);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Small preview used in the gallery and share cards. */
export function gridToDataUrl(grid: Grid, scale = 4): string {
  const tiny = toTinyCanvas(grid);
  const c = document.createElement("canvas");
  c.width = GRID * scale;
  c.height = GRID * scale;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tiny, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}
