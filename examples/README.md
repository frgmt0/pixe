# Examples

## `playwright-solver.ts`

A reference solver for the pixe agent benchmark. It exists to show the shape of
a run played the way the benchmark intends, not to set a bar.

```bash
bun add -d playwright
bunx playwright install chromium
PIXE_URL=http://localhost:5173 bun run examples/playwright-solver.ts
```

| variable | default | what it does |
| --- | --- | --- |
| `PIXE_URL` | `https://pixe.frgmt.xyz` | point it at `http://localhost:5173` to play a dev server |
| `PIXE_OPERATOR_KEY` | unset | your human's `pxop_…` key. With it, pairing never happens |
| `PIXE_PUZZLES` | `1` | how many rungs to attempt before stopping |
| `PIXE_ROUNDS` | `24` | repair rounds spent on a board before walking away |
| `PIXE_HEADED` | unset | `1` to watch it paint |
| `PIXE_PAIR_MS` | `600000` | how long to leave a human to type the code |

## It never calls the API

This is the part worth copying. The solver makes **no HTTP requests of its
own** — not `/api/next`, not `/api/attest`, and above all not `/api/submit`. It
fills in the register form, presses keys, drags the mouse and clicks the submit
button; every request the server sees is one the page made because the script
did something to it.

That is not ceremony. A submission has to carry an attestation receipt proving
the pixels came from real input, the receipt lives in the page's own state, and
there is no way to obtain one from outside the browser. A script that posts its
own grid to `/api/submit` is refused, and it should be: the benchmark is
measuring whether you can drive a browser, so a solver that routes around the
browser is not scoring badly, it is not playing.

Registering over the API from inside the page — `page.evaluate(() => fetch(…))`,
the shape `agents.txt` documents — is a different matter and perfectly fine;
same-origin from the page carries the cookie and the attestation both. The
solver uses the form only because the form is right there and takes the operator
key too.

## What it actually does

Three stages, all crude, and the deduction is meant to be beaten.

**Survey.** Coat the entire board in one hue — four full-width rectangle drags —
wait for the page to attest, and read which cells the board flashes at. Repeat
for all eight hues. This costs eight bursts of painting and no submits at all:
the page attests as it paints and the answer comes back on the canvas, so the
placement channel is free to anyone already driving the UI. What it yields is a
map of where each colour is tolerated *by its own kind*, which is not the same
question as where it belongs in the finished picture. That gap is most of why
this is a baseline — and on a board carrying a law that no solid colour can
satisfy anywhere, every coat objects everywhere, the map says nothing at all,
and the repair pass is the only thing left doing any work.

**Fill.** Carve the board into sixteen 16×16 blocks, each into four horizontal
bands, and give every band the least objectionable colour still unused in its
block. Four different colours per block rather than one good one, because a zone
law is a permit list *and* a coverage floor — a region painted a single colour
fails by construction however well that colour is tolerated.

**Repair.** Read the flashing cells off the canvas, repaint the eight worst
bands one step further down the survey's ranking, and look again. It is a hill
climb with no memory beyond the canvas and no backtracking. It gets stuck, and
it ignores the swatch channel entirely, so a board that comes down to a quota is
a board it cannot finish.

It submits every fourth round — a submit is an observation too, just the
expensive one — and immediately when the submit button's own label changes to
*Bank it*, which is the board saying the grid is done.

## What a good score looks like

The benchmark ranks on **median wall clock per solve**, measured server-side from
the moment a puzzle was issued to the moment a solution was accepted. Everything
else on the table is context. The headline projection follows directly from it:

| median per solve | projected to clear all 1,000,000 puzzles, serially |
| --- | --- |
| 5 s | 1,389 h — 58 days |
| 10 s | 2,778 h — 116 days |
| 30 s | 8,333 h — 11 months |
| 1 min | 16,667 h — 1.9 years |
| 5 min | 83,333 h — 9.5 years |

Read those as what they are: one agent, one board at a time. The chained sequence
means there is no parallel version of this number, so a projection is a
projection of serial work and nothing else.

Per rung this solver spends about a hundred gestures, a couple of hundred
attested events and two or three submits, with nearly all of its wall clock
going into painting rather than thinking. Expect it to clear an easy rung now
and then, stall on most of the rest, and post a median in the minutes. That is
arithmetic off the loop it runs, not a measurement; the table at `/bench` is the
only real answer.

One run against a dev server, for calibration: rung 0, 36 attest round trips and
5 submits over 24 rounds, flashing cells coming down 3072 → 0 — and then the
Banana swatch still buzzing on a full, placement-clean grid. A counting law it
never looked at, one rung in. That is the baseline, exactly.

Two directions to beat it in, and they are independent:

- **Deduce better.** Fewer rounds per solve. The swatch channel eases off as a
  counting law is approached rather than snapping at a threshold, so it can be
  climbed instead of guessed at — this solver ignores it entirely.
- **Paint fewer times.** Most of its clock is input events for grids it already
  knows are wrong. Deciding on the grid before painting it is worth more than any
  amount of faster clicking.

## The seams that can rot

The protocol in `shared/protocol.ts` and `docs/AGENT-PROTOCOL.md` is stable. The
parts of this script that touch the UI are not, and are the first place to look
if it stops working. Every one of these is current as of this writing:

**Screens.** `/play` is four screens in sequence and the solver walks all four:
a register form (labelled fields *Agent*, *Model*, *Operator key*, and a
*Register* button); a pairing screen headed *Ask your human* showing an
`ABCD-EFGH` code; a *Take the next puzzle* button when nothing is open; and the
board itself.

**The board.** A `role="application"` element labelled *64 by 64 painting grid*,
holding three stacked canvases. The first is the artwork at 64×64, the second is
the violation layer — any cell with a non-zero alpha there is a cell the board
is flashing at — and the third is the cursor at display resolution. Reading
those two is how the solver sees both feedback channels; the swatch buzz is on
the palette buttons instead, whose `aria-label` gains *something is off with
this colour*.

Each canvas now also carries a `data-pixe-layer` attribute — `art`,
`violations`, `cursor` — and **that is the handle to use**. The stacking order
is unchanged and positional lookup still works, so nothing that already worked
has broken; but position is an accident of layout and the attribute is a
promise. `src/game/execProof.ts` still finds the art layer positionally and has
a comment saying it would rather not; it can now be switched over.

Nothing else about the board is contractual. In particular the empty-cell
colour is `EMPTY_RGB` from `shared/palette.ts` and is **not** a style choice:
`server/exec-bind.ts` re-derives the expected pixel bytes from the grid using
it, so the art canvas has to keep painting exactly that. A redesign may reframe
the board but must not repaint it.

**Hotkeys.** `1`–`8` hue, `b` brush, `g` bucket, `r` rectangle, `e` eraser, `i`
picker, `[` and `]` brush size, `m` mirror. They are window-level and ignored
while a text field has focus.

**Buttons.** *Wipe the canvas* clears the board. *Abandon this board* takes the
next rung and answers 429 until the board has been held sixty seconds. The
submit button is **never disabled** and its label is the board's verdict:
*Submit and see what breaks* normally, *Bank it for N pts* once the last round
trip came back solved. A banked board opens a dialog with the rule reveal and a
*Next rung →* button.

**The header** reads `Rung 3 · L12 · 214 attested events`. That last number only
moves when `/api/attest` answers, which makes it both the solver's "the page has
told the server what I did" signal and the first place a broken run shows up: a
counter that has stopped moving means the page is no longer attesting for you,
and a submit is not going to be bankable.
