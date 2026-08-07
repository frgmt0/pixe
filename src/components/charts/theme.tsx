/**
 * Chart tokens.
 *
 * The charts are hand-rolled SVG, so their colours cannot come from Tailwind
 * utility classes on the marks — SVG paints through `fill`/`stroke`. They come
 * from CSS custom properties instead.
 *
 * The neutrals are now *aliases* of the app-wide tokens in `index.css` rather
 * than a second set of values. That is the whole reason the redesign could
 * change the page surface safely: there is one place where light becomes dark,
 * and the charts follow it. What is left here is the part that is genuinely
 * chart-specific — the three series hues, which do need their own per-mode
 * values because they are selected against the surface rather than derived
 * from it.
 */

/**
 * Three series, and the cap is load-bearing rather than a layout preference.
 *
 * These are scatter plots: any two runs' dots can land next to each other, so
 * every pair must be distinguishable, not merely the neighbouring ones. Under
 * that test — simulated protanopia and deuteranopia, Machado–Oliveira–Fernandes
 * at severity 1.0, ΔE ≥ 8 in OKLab ×100, all pairs — three hues is what clears
 * it in both modes. A fourth (violet) passes on the light surface and collapses
 * into blue on the dark one. So the plots show three runs at a time and
 * everything else folds into one grey "other runs" wash; the table carries all
 * of them.
 */
export const SERIES_CAP = 3;

export const seriesVar = (slot: number): string => `var(--viz-series-${(slot % SERIES_CAP) + 1})`;

/**
 * Emitted once per screen. Inline rather than in `index.css` because these are
 * the bench screen's tokens and nothing else in the app draws a chart; keeping
 * them next to the marks they paint is what stops them drifting.
 */
export function ChartTokens() {
  return <style>{TOKENS}</style>;
}

/*
  Re-validated against the redesigned surfaces with the dataviz skill's own
  script (`validate_palette.js … --pairs all`), because changing the page
  colour voids the previous run:

    light, surface #fafaf7 — worst all-pairs CVD ΔE 9.2 (aqua↔orange, deutan),
                             normal-vision floor 24.0, one contrast relief
    dark,  surface #101011 — worst all-pairs CVD ΔE 9.4 (aqua↔orange, deutan),
                             normal-vision floor 20.9, all three over 3:1

  The hues are unchanged from the previous surfaces because they still pass and
  because the alternatives are worse: darkening the aqua to clear 3:1 on the
  new, lighter page drops its separation from the orange to ΔE 5.5–7.4, which
  is a real failure traded for a conditional one. The aqua sits at 2.69:1 on
  the light surface, which the skill permits only with a relief channel — that
  relief is the legend label on every fitted series and the full solve table
  under the charts, so neither is an optional extra.
*/
const DARK = `
    --viz-series-1: #3987e5;
    --viz-series-2: #d95926;
    --viz-series-3: #199e70;
    --viz-other: #55554f;
`;

const TOKENS = `
.viz-root {
  --viz-ink: var(--ink);
  --viz-muted: var(--muted);
  /* The charts had a third ink step; the redesign has two colours and no more,
     so "soft" and "muted" are the same value. Kept as a name because the mark
     code distinguishes label text from tick text and that distinction may earn
     a value again. */
  --viz-ink-soft: var(--muted);
  --viz-surface: var(--page);
  --viz-surface-2: var(--sunk);
  --viz-grid: var(--rule-soft);
  --viz-axis: var(--rule);

  --viz-series-1: #2a78d6;
  --viz-series-2: #eb6834;
  --viz-series-3: #1baf7a;
  --viz-other: #b4b4ad;

  color: var(--viz-ink);
}

@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) .viz-root {${DARK}  }
}
/* The explicit stamp must win in both directions. */
:root[data-theme="dark"] .viz-root {${DARK}}

.viz-plot text { fill: var(--viz-muted); }
.viz-plot .viz-tick { fill: var(--viz-muted); }
.viz-dot { transition: r 90ms ease; }
.viz-frame:focus-visible { outline: 1px solid var(--viz-ink); outline-offset: 2px; }
`;
