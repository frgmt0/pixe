import { useCallback, useEffect, useRef } from "react";
import { CELLS, EMPTY_RGB, GRID, HUE_RGB } from "@shared/palette";
import type { Grid } from "@shared/rules";
import { mirrorPoints, type Mirror, type Tool } from "./board";

export interface CanvasHandlers {
  onDown(x: number, y: number, alt: boolean): void;
  onMove(x: number, y: number): void;
  onUp(x: number, y: number): void;
  onHover(x: number, y: number): void;
  onLeave(): void;
}

interface Props {
  grid: Grid;
  /** Bumped by Board on every mutation; drives repaints. */
  version: number;
  badCells: Set<number>;
  tool: Tool;
  brush: number;
  mirror: Mirror;
  hue: number;
  showGrid: boolean;
  handlers: CanvasHandlers;
}

/**
 * Three stacked 64x64 canvases, CSS-scaled with `image-rendering: pixelated`.
 * Painting at native grid resolution keeps every repaint a 4096-pixel
 * ImageData write regardless of how large the board is on screen — rendering
 * 4096 DOM nodes instead would jank badly on every stroke.
 *
 *   art     the artwork itself
 *   marks   the violation flash (see below)
 *   cursor  brush preview + optional grid lines, at display resolution
 */
export function PixelCanvas({
  grid,
  version,
  badCells,
  tool,
  brush,
  mirror,
  hue,
  showGrid,
  handlers,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const artRef = useRef<HTMLCanvasElement>(null);
  const marksRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLCanvasElement>(null);

  const artData = useRef<ImageData | null>(null);
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);
  const latest = useRef({ grid, badCells, tool, brush, mirror, hue, showGrid, handlers });
  latest.current = { grid, badCells, tool, brush, mirror, hue, showGrid, handlers };

  /* --- artwork layer ---------------------------------------------- */

  useEffect(() => {
    const ctx = artRef.current?.getContext("2d");
    if (!ctx) return;
    if (!artData.current) artData.current = ctx.createImageData(GRID, GRID);
    const px = artData.current.data;
    for (let i = 0; i < CELLS; i++) {
      const v = grid[i]!;
      const rgb = v < 0 ? EMPTY_RGB : HUE_RGB[v]!;
      const o = i * 4;
      px[o] = rgb[0];
      px[o + 1] = rgb[1];
      px[o + 2] = rgb[2];
      px[o + 3] = 255;
    }
    ctx.putImageData(artData.current, 0, 0);
  }, [grid, version]);

  /* --- violation layer --------------------------------------------- */

  /**
   * The only channel through which the game teaches a placement rule: bad
   * cells flash. Alternating red and near-black keeps them legible on top of
   * any of the eight hues, including Tomato.
   */
  useEffect(() => {
    const canvas = marksRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const buf = ctx.createImageData(GRID, GRID);
    let raf = 0;
    let start = 0;

    const draw = (now: number) => {
      if (!start) start = now;
      const bad = latest.current.badCells;
      const px = buf.data;

      if (bad.size === 0) {
        ctx.clearRect(0, 0, GRID, GRID);
        raf = requestAnimationFrame(draw);
        return;
      }

      // ~1.1 Hz so it reads as an alarm without being a strobe, even when a
      // systemic mistake lights up a large share of the board.
      const phase = reduced ? 1 : (Math.sin(((now - start) / 1000) * Math.PI * 2 * 1.1) + 1) / 2;
      const r = Math.round(255 * phase + 23 * (1 - phase));
      const g = Math.round(59 * phase + 20 * (1 - phase));
      const b = Math.round(59 * phase + 31 * (1 - phase));
      const a = Math.round(200 + 40 * phase);

      px.fill(0);
      for (const i of bad) {
        const o = i * 4;
        px[o] = r;
        px[o + 1] = g;
        px[o + 2] = b;
        px[o + 3] = a;
      }
      ctx.putImageData(buf, 0, 0);
      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  /* --- cursor / grid layer ----------------------------------------- */

  useEffect(() => {
    const canvas = cursorRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    let raf = 0;
    const render = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(rect.width));
      if (canvas.width !== w * dpr) {
        canvas.width = w * dpr;
        canvas.height = w * dpr;
      }
      const ctx = canvas.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, w);
      const cell = w / GRID;

      if (latest.current.showGrid && cell >= 4) {
        ctx.strokeStyle = "rgba(255,255,255,0.13)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 8; i < GRID; i += 8) {
          ctx.moveTo(Math.round(i * cell) + 0.5, 0);
          ctx.lineTo(Math.round(i * cell) + 0.5, w);
          ctx.moveTo(0, Math.round(i * cell) + 0.5);
          ctx.lineTo(w, Math.round(i * cell) + 0.5);
        }
        ctx.stroke();
      }

      const h = hoverRef.current;
      if (h) {
        const { tool: t, brush: bsize, mirror: m } = latest.current;
        const size = t === "bucket" || t === "picker" ? 1 : bsize;
        const half = (size - 1) / 2;
        ctx.lineWidth = 2;
        for (const [mx, my] of mirrorPoints(h.x, h.y, m)) {
          const x0 = Math.max(0, Math.round(mx - half));
          const y0 = Math.max(0, Math.round(my - half));
          const isPrimary = mx === h.x && my === h.y;
          ctx.strokeStyle = isPrimary ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.5)";
          ctx.strokeRect(x0 * cell, y0 * cell, size * cell, size * cell);
          ctx.strokeStyle = "rgba(0,0,0,0.55)";
          ctx.strokeRect(x0 * cell - 2, y0 * cell - 2, size * cell + 4, size * cell + 4);
        }
      }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);

  /* --- pointer plumbing -------------------------------------------- */

  const cellAt = useCallback((e: { clientX: number; clientY: number }): [number, number] | null => {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    const rect = wrap.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * GRID);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * GRID);
    if (x < 0 || y < 0 || x >= GRID || y >= GRID) return null;
    return [x, y];
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    const c = cellAt(e);
    if (!c) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragging.current = true;
    hoverRef.current = { x: c[0], y: c[1] };
    // Alt-click picks the colour under the cursor, the way every paint app works.
    latest.current.handlers.onDown(c[0], c[1], e.altKey || e.button === 1);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const c = cellAt(e);
    if (!c) {
      if (!dragging.current) {
        hoverRef.current = null;
        latest.current.handlers.onLeave();
      }
      return;
    }
    hoverRef.current = { x: c[0], y: c[1] };
    latest.current.handlers.onHover(c[0], c[1]);
    if (dragging.current) latest.current.handlers.onMove(c[0], c[1]);
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    const c = cellAt(e) ?? [hoverRef.current?.x ?? 0, hoverRef.current?.y ?? 0];
    latest.current.handlers.onUp(c[0]!, c[1]!);
  };

  const layer = "absolute inset-0 h-full w-full pixelated";

  return (
    <div
      ref={wrapRef}
      className="relative aspect-square w-full touch-none overflow-hidden rounded-xl ink-border bg-cloth shadow-chunk-lg"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => {
        if (!dragging.current) {
          hoverRef.current = null;
          latest.current.handlers.onLeave();
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
      role="application"
      aria-label={`${GRID} by ${GRID} painting grid`}
    >
      <canvas ref={artRef} width={GRID} height={GRID} className={layer} />
      <canvas ref={marksRef} width={GRID} height={GRID} className={layer} />
      <canvas ref={cursorRef} className={`${layer} pointer-events-none`} />
      <span className="sr-only">
        Currently painting with hue {hue}. Use the palette and tool buttons to change modes.
      </span>
    </div>
  );
}
