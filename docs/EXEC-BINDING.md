# Execution binding

`server/exec-bind.ts` + `src/game/execProof.ts`

The attestation receipt in `server/attest.ts` can be obtained and advanced
entirely over HTTP. Nothing in that chain requires the client to have executed
page code in a browser engine — the events are self-reported structure, and a
script that bothers to synthesise them clears the gate. This layer adds a
challenge the page answers by reading pixels back off the canvas it has already
rendered, so producing a valid receipt means having actually rendered.

## The honest claim, first

**This is not a proof and it cannot be made into one.** Every challenge here is
verified by the server, which means the server also computes the answer, which
means the answer is a deterministic function that can be reimplemented outside a
browser by anyone willing to write it. There is no arrangement of this idea that
escapes that, and any version of this document that says "proves" or
"guarantees" is wrong.

What it buys is a **port cost**. To answer, a bare HTTP client has to
reimplement the parts of a rendering engine the shipped page gets for free. The
bet is that the honest path — drive Playwright, call one function per batch — is
cheaper than the port, and stays cheaper as the page changes underneath it.

That bet is modest and the cost is measured below in what it would actually take
an attacker, not in adjectives. This project has already had one "known and
accepted" note turn into a 1105-solve exploit; the section titled **What defeats
this** is the important part of the page.

## Who it is aimed at

Agents driving the site with **Playwright or Puppeteer, headless included**.
Headless Chromium answers all three layers trivially — verified below — and that
is the design working, not a hole. The bar being set is "did this code run in an
engine that lays out DOM and rasterises a canvas", nothing narrower.

Nothing here samples a signal that distinguishes an automated browser from a
human-driven one. Specifically not sampled, and not to be added later:

- `navigator.webdriver`, which is `true` under Playwright and Puppeteer by default
- headless-vs-headful detection of any kind — plugins, `navigator.languages`,
  permissions quirks, UA substrings
- WebGL or GPU fingerprints, which differ or are absent in headless and in containers
- font enumeration, or anything else that varies with the absence of a display server
- timing signals that assume a real compositor at 60Hz on real hardware

Every one of those fires hardest on the legitimate audience. A check that
penalises headless Chromium is strictly worse than no check at all.

## The three layers

### 1. Canvas readback — load-bearing

`PixelCanvas` stacks three 64×64 canvases and scales them with CSS
`image-rendering: pixelated`. The art layer is written as one `ImageData` at
native grid resolution, so a 1:1 `getImageData(0, 0, 64, 64)` returns **exactly**
the palette-mapped grid — no resampling, no engine-specific filtering, alpha
always 255. Cell `c` starts at byte `c * 4`.

That identity is the whole reason this layer is worth anything: the server holds
the grid, so it can compute the same bytes without the client's help.

The server picks twelve cells per challenge, the page reads them off the live
canvas, and the answer is

```
px = SHA-256("pixe/exec/px/1:" + cid + ":" + <RGBA bytes, hex, in challenge order>)
```

truncated to 32 hex characters. This is the only layer that feeds the gate.

### 2. Computed style — advisory

Three declarations applied to a throwaway element attached to the document, read
back through `getComputedStyle`. The templates are chosen so every answer is
fixed by CSSOM rather than by an engine's taste:

| declaration | read | answer | why it is stable |
| --- | --- | --- | --- |
| `color:#RRGGBB` | `color` | `rgb(r, g, b)` | legacy sRGB serialisation |
| `font-size:16px;width:Nem` | `width` | `16N px` | `em` is absolutised at computed-value time |
| `--pixe-xN:<token>` | `--pixe-xN` | `<token>` | custom properties round-trip as authored |

Recorded in the receipt, never enforced. A mismatch here is meant to mean "no
CSSOM ran", and if it ever starts meaning "not Chrome" the counter is what makes
that visible before anyone is refused a solve.

### 3. Frame loop — advisory

The prover waits for two or three `requestAnimationFrame` callbacks and reports
their timestamps. The server checks that they are finite, non-negative and
non-decreasing. **That is the entire test.** Frame *rate* is never inspected:
headless engines schedule frames on a virtual clock and containers stall for
seconds at a time, and both are legitimate players here. A backgrounded tab
stops firing frames altogether, so the prover gives up after 250ms and sends
what it has.

## Binding

The challenge id is

```
cid = HMAC(run secret, "pixe/exec/cid/1:" + runId + ":" + idx + ":" + seq).slice(0, 22)
```

and the probe cells and style parameters come from two more HMACs over the same
scope. So an answer cannot be:

- **precomputed** — the run secret never leaves the database
- **replayed across positions** — `seq` is the exec receipt's chain position, and
  the answer is hashed with `cid`
- **moved between issues** — `idx` is in the scope
- **lifted from another run** — `runId` and the secret are in the scope

`seq` advances on every verified proof, carried in an HMAC-signed receipt with
the same shape and the same domain separation as the attestation receipt. The
serialisation property is inherited wholesale: a thousand concurrent proofs all
chained from receipt zero produce a thousand tallies of one, because there is no
operation that merges them.

## Degradation

**Nothing in this module rejects a request.** `verifyExecProof` always returns a
tally, a receipt and the next challenge. A proof that is absent, malformed,
stale, or simply wrong advances the chain and increments nothing; the verdict
carries a diagnostic note (`no-proof`, `stale-challenge`, `no-grid`,
`canvas-mismatch`, `receipt-reset`, `style-mismatch`) and nothing branches on it.

An unreadable receipt restarts the chain rather than erroring, for the same
reason `attest.ts` accepts a stale one: starting over only ever *lowers* the
tally, which never helps anybody.

Enforcement happens in exactly one place, `gateExec`, at submit. It asks for
**three** matching readbacks. A page painting a 4096-cell board settles dozens of
times, so the honest margin over the gate is an order of magnitude — which is
what keeps an innocent canvas/grid skew from ever costing somebody a solve.

**Turn it on in observe-only mode.** A client that has not been taught to send
proofs — an older page, a harness driving the JSON API, anything mid-rollout —
produces an empty tally and would be refused by a gate that is live on day one.
Log the complaint, watch how often it fires on runs that are plainly honest, and
only then turn it into a 403.

## What was verified, and how

Verified in a real browser, against the real app on a dev server
(`PIXE_DB=./data/exec-dev.sqlite bun run dev`), Playwright Chromium 1.62,
headless **and** headful, 25 checks each:

- The canvas readback equals the server's palette mapping, at three consecutive
  chain positions, on a board with 180 hand-painted cells. The two sides are
  independent: the render side is `proveExec` reading the live canvas, the model
  side is the app's own `localStorage` draft, encoded from `board.grid`.
- The exec receipt chain advances and the tally accumulates 1 → 2 → 3.
- A proof does not answer another position's challenge.
- All three style templates answered exactly as the server expected
  (`rgb(167, 144, 55)`, `96px`, `t311v`, …).
- `requestAnimationFrame` timestamps arrive and advance.

**Skew, measured rather than assumed.** The one honest source of
`canvas-mismatch` is the canvas being painted from a React effect while the grid
is snapshotted separately. Proving *immediately* at pointer-up with no debounce —
the worst case — matched the model **20 times out of 20**. The prover's two-frame
wait is enough for the effect and the `putImageData` to have landed.

Reasoned about, **not** verified:

- **Cross-engine style serialisation.** Only Chromium was available here
  (`~/.cache/ms-playwright` has no Firefox or WebKit build). The three templates
  are chosen from CSSOM-specified behaviour, and the layer is advisory precisely
  because that argument is on paper. If Firefox or WebKit disagree, the counter
  drops and nobody is refused anything.
- **Bun and Workers parity.** `exec-bind.ts` uses `crypto.subtle`, `atob`/`btoa`,
  `TextEncoder` and nothing else; no Node built-ins, no imports outside
  `shared/palette` and `server/attest`. That is the same surface `attest.ts`
  already runs on both runtimes, but it has not been exercised on D1.

## What defeats this

Listed because they are real, not because they are handled.

1. **Reimplementing the readback.** An attacker who is generating grids already
   holds the grid. Given the challenge — which the server hands them — answering
   layer 1 is: index the grid at twelve cells, map through `HUE_RGB`, append
   `ff`, SHA-256 it. That is about twenty lines. **This is the cheapest defeat
   and there is no version of a server-verifiable challenge that avoids it.**
2. **Reimplementing the advisory layers.** Layer 2 is a lookup table with three
   entries; layer 3 is three increasing numbers. Together another twenty lines.
3. **Reading the bundle.** `execProof.ts` ships as plain TypeScript compiled by
   Vite. Minification is obfuscation-grade only — a determined reader recovers
   the logic in an afternoon, and should be assumed to have done so. No WASM, no
   extra toolchain: this project builds with Vite and Bun and adds no
   dependencies without cause, and a hand-written WASM blob would buy hours of
   confusion in exchange for a permanent maintenance tax.
4. **Driving a browser once, then scripting.** An attacker can run a real page
   to observe the exact wire format and then reproduce it headlessly. Nothing
   here prevents that, and the intended audience is doing something very similar
   on purpose.
5. **A stolen canvas.** Any renderer that can produce the same 64×64 ImageData
   answers layer 1 — including a headless engine driven for the sole purpose of
   answering challenges, or `node-canvas`. The layer tests "something rasterised
   this", not "our page rasterised this".

What it does cost, honestly: an attacker must now keep a model of the page's
render pipeline in step with the page. The probe cells and the style questions
change per proof, so hard-coded answers fail on the second challenge rather than
never. And the honest path is one `await proveExec(challenge)` in the batch loop.
That is the entire economic argument. It is a speed bump on the way to the JSON
API, not a wall.

## Where it does not help at all

- It says nothing about **who** is playing. Identity is out of scope everywhere
  in this project and stays out of scope here.
- It does not make an individual solve harder, slower or more honest. A solver
  that beats a board in 400ms still beats it in 400ms, plus one canvas readback.
- It does not constrain method. Writing a custom solver is the skill being
  measured.
- The **chained puzzle sequence** in `server/runs.ts` remains the only
  unforgeable thing in the system. If this layer were removed tomorrow the
  benchmark would still measure serial solving. See `docs/THREAT-MODEL.md`.

## Wiring

`server/exec-bind.ts` registers no route and `src/game/execProof.ts` mounts no
component. Both are pure modules for the lead agent to call.

**`server/runs.ts` — `boardPayload`**, alongside the attestation receipt:

```ts
import { execChallenge, openExecReceipt } from "./exec-bind";

exec: await execChallenge(run.secret, run.id, issue.idx, 0),
execReceipt: await openExecReceipt(run.secret, run.id, issue.idx),
```

**`server/runs.ts` — `postAttest`**, after `verifyAttest` succeeds and after the
envelope's grid has been decoded (pass `null` for `grid` when the envelope
carried no `art`):

```ts
const ex = await verifyExecProof({
  secret: run.secret, runId: run.id, idx: issue.idx,
  receipt: body.execReceipt, proof: body.exec, grid, now,
});
out.execReceipt = ex.receipt;
out.exec = ex.challenge;
```

Move the `decodeGrid(v.art)` call above this so the grid is available; a `null`
grid is a legitimate inconclusive, not an error.

**`server/runs.ts` — `postSubmit`**, beside `gateSubmit`:

```ts
const exTally = await readExecReceipt(run.secret, run.id, issue.idx, body.execReceipt);
const exGate = exTally ? gateExec(exTally, now) : "No execution proof for this puzzle.";
// Observe-only to begin with. Log it; do not return 403 until the rate of
// false complaints on plainly honest runs is known to be zero.
```

**`src/game/usePuzzle.ts` — `sendBatch`**, immediately before the grid snapshot:

```ts
const proof = await proveExec(chain.current.exec);
const snapshot = moved ? Int8Array.from(board.grid) : null;
// ... api.attest({ ..., exec: proof, execReceipt: chain.current.execReceipt })
chain.current = { receipt: ack.receipt, nonce: ack.nonce,
                  exec: ack.exec, execReceipt: ack.execReceipt };
```

Prove first, snapshot second. A stroke landing between the two costs one
uncounted proof out of dozens.

**`src/lib/api.ts`** — carry `exec` and `execReceipt` through `AttestBody`,
`Attested` and `Issue`. They are opaque to that module, like the receipt and the
nonce already are.

**One optional change worth making.** `proveExec` finds the art canvas
positionally: the first 64×64 `<canvas>` inside the `[role="application"]`
wrapper. A `data-pixe-layer="art"` attribute on that element in `PixelCanvas.tsx`
would make it exact. Without it, reordering the canvas stack produces
inconclusive proofs — degrading safely, but silently.
