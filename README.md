# pixe

A 64×64 pixel puzzle game. Every board hides its own laws about which colours may go
where and which colours can stand next to each other. **You are never told any of them.**
You paint, the grid reacts, and you work the rest out yourself.

Fill all 4096 squares without breaking a single law and you bank the puzzle's points.
Then you share the art.

## Run it

```bash
bun install
bun run dev        # API on :3001, Vite on :5173 — open http://localhost:5173
```

Production:

```bash
bun run build      # typecheck + bundle to dist/
bun run start      # single Bun process serving the API and dist/ on :3001
```

Tests:

```bash
bun test           # 33 tests, including a 520-puzzle solvability sweep
```

Env: `PORT` (default 3001), `PIXE_DB` (default `./data/pixe.sqlite`), `NODE_ENV`.

## How the game teaches without telling

This is the whole design, so it's worth being precise about it.

There are exactly two feedback channels, and neither one ever names a law:

1. **Cells flash.** Any square that breaks a placement law pulses red-to-black at about
   1.1 Hz. Legible on top of all eight hues, including Tomato.
2. **Swatches buzz.** Counting laws (quotas, per-row limits) have no single guilty
   square to light up, so the *palette swatch* twitches instead. It tells you which
   colour is implicated, never why.

The second channel exists because of a specific dead end: a law like "Mint must cover at
least 47 cells" can be broken on a completely filled grid with no wrong cell anywhere.
Without a swatch reaction the player would face a finished canvas, a dark submit button,
and zero information. `shared/engine.test.ts` asserts the invariant directly — across 60
puzzles × 12 grid states, **no failing law is ever invisible**.

The mirror of that rule matters just as much: a law that is merely *unfinished* must stay
silent while blank cells remain, or the board would be nagging about requirements the
player has not been told about and cannot yet have broken. Silence is only a bug once the
grid is full. The test checks both halves.

There are no hints, no teasers, no law counter, and no rule text anywhere during play.
Rule text exists in exactly two places, both after the fact: the post-solve reveal and
the public share page. It can't help you there.

A **Field Notes** pad sits in the sidebar for writing down what you deduced. It's yours;
the game never writes in it.

## How puzzles are generated

The generator builds the **reference solution first**, then reads the laws back off it.

Randomly sampling constraints and hoping they're jointly satisfiable over 4096 cells
produces unwinnable boards, and an unwinnable board makes the leaderboard a lie. Instead:

1. Seed → PRNG (`shared/prng.ts`, mulberry32 + FNV-1a).
2. Pick a zone scheme — quadrants, stripes, concentric rings, diagonals, checkerboard,
   bullseye — and a hue palette per zone.
3. Paint a reference solution with two octaves of value noise, so regions come out blobby
   rather than confetti. Blobby is what makes adjacency laws derivable at all.
4. Plant structure smooth noise would never produce by accident: scatter one hue onto
   same-parity cells (same-parity cells are never orthogonally adjacent, so this makes
   parity, lonely, noBlock *and* a tight quota all true at once); evict a hue from the
   border band.
5. Enumerate ~150 candidate laws and **test every one against the reference solution**,
   keeping only those that actually hold.
6. Select a type-diverse subset, at most one law per hue or hue pair — otherwise you get
   both `forbidAdj(A,B)` and `farApart(A,B)`, where the second strictly implies the first.
7. Point value is **computed** from summed rule weights and mapped onto a 3–7 band. Never
   hand-set.

Because the reference solution satisfies every derived law by construction, a solution
provably exists. The test suite regenerates 520 puzzles and asserts each one's own target
validates clean.

### Why zone laws carry a coverage floor

Every law except `zone` names specific hues. A player who simply never paints those hues
satisfies all of them *vacuously* — and a zone law that only permits hues is perfectly
happy with a solid fill. Left alone, that collapses the entire game: paint one bucket per
region, collect full points, deduce nothing.

It was measured, not theorised. Over 120 ladder puzzles:

| cheap strategy | beat the puzzle |
| --- | --- |
| one solid hue per zone, no floor | **96%** |
| solid zone + one token pixel of each other permitted hue | **33%** |
| both, with the coverage floor in place | **0%** |

So a zone law is a permit list *and* a requirement list: each listed hue must cover at
least `each` cells of that region, where `each` is half the scarcest hue's count in the
reference solution (so the target clears it with room to spare, and the player is never
asked to match an exact number). Both strategies are now permanent regression tests.

The floor also fixes the scoring. Point value is summed rule weight, and before the fix
much of that weight came from laws no player could ever trip — the leaderboard was ranking
patience rather than deduction.

### The twelve law primitives

`zone` · `forbidAdj` · `requireAdj` · `farApart` · `quotaMin` · `quotaMax` · `lineLimit` ·
`parity` · `noBlock` · `buddy` · `lonely` · `border`

Laws are keyed by **hue** and by **zone**. Per-cell variation comes from zone membership —
4096 independent per-cell laws would be undeducible by construction, so "each spot has
different rules" is implemented as "each *region* has different rules."

## Scoring

- Each puzzle is worth 3–7 points based on computed difficulty. Solve it once, bank it once.
- **Bonds** are a secondary flourish: each puzzle nominates one or two hue pairs that score
  a point every time they touch. Not required to solve — it's the artistic score, shown
  against the reference solution's "par".
- The ladder is endless and ramps in difficulty. The daily puzzle is the same board for
  everyone until midnight UTC.

## Anti-cheat

The client only ever sends pixels. On submit the server re-derives the puzzle from its
seed, re-runs the identical shared validator, and computes the point value itself. A
forged grid, an incomplete grid, or a grid one cell off is rejected with 422. Re-solving a
banked puzzle pays zero.

Verified: solid-colour grid → 422, one empty cell → 422, one wrong cell → 422, genuine
solution → 200, replay → 0 points.

**Known and accepted:** the client computes the laws locally from the seed in order to
drive the live glow, so anyone reading devtools can extract them. That's inherent to
having client-side feedback at all, and it only spoils the discovery for the person doing
it — the leaderboard stays honest because the server validates the actual pixels.

## Architecture

```
shared/     isomorphic engine — the same code validates in the browser and on the server
  prng.ts       seeded PRNG
  palette.ts    the eight hues
  zones.ts      zone schemes
  rules.ts      law primitives + evaluation
  generate.ts   target-first generation and law derivation
  validate.ts   the single assessment path both sides call
  codec.ts      run-length grid codec
server/     Bun.serve + bun:sqlite + Bun.password (argon2id), HttpOnly session cookies
src/        React 19 + Vite + Tailwind v4
  game/       Board (mutable, diff-based undo), PixelCanvas, palette, toolbar
  screens/    Auth, Ladder, Play, SharedArt
```

**Performance.** The grid is three stacked 64×64 canvases scaled up with
`image-rendering: pixelated`, not 4096 DOM nodes — every repaint is one 4096-pixel
`ImageData` write regardless of display size. The board is a plain mutable object outside
React state; assessment runs once per animation frame rather than per pointer event
(a full 8-law pass costs ~0.17ms). Undo holds 500 per-stroke diffs, because probing and
reverting *is* the gameplay here.

## A note on 21st.dev

The task asked for 21st.dev components. The registry is reachable but **gated** — real
component slugs return `403 Authentication required` without an API token:

```
403  https://21st.dev/r/originui/button
403  https://21st.dev/r/motion-primitives/text-shimmer
```

So the UI primitives in `src/components/ui/` are hand-written in shadcn's exact shape and
file layout (`button.tsx`, `input.tsx`, `card.tsx`, `badge.tsx`, `dialog.tsx`, with
`cn()` in `src/lib/utils.ts`), on the standard substrate 21st.dev components expect:
Radix primitives, `class-variance-authority`, Tailwind v4. `components.json` is configured
with the 21st registry.

Once you've authenticated the shadcn CLI, real components drop straight in and overwrite
these:

```bash
bunx shadcn@latest add "https://21st.dev/r/<author>/<component>"
```
