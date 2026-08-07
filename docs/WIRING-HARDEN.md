# Wiring the HARDEN layer

Everything below is what the lead agent has to do to activate `server/runs.ts`,
`server/attest.ts` and `shared/dialect.ts`. Nothing in those three files
registers a route or touches the DOM on its own.

## 1. `server/router.ts`

One import and one early-return. `handleRunApi` returns `null` for a path it
does not own, so it composes rather than replaces.

```ts
import { handleRunApi } from "./runs";

export async function handleApi(req: Request, url: URL, deps: Deps): Promise<Response> {
  const handled = await handleRunApi(req, url, deps);   // FIRST, before anything else
  if (handled) return handled;
  /* ... /api/bench, /api/gallery, /api/art/:id ... */
}
```

`RunDeps` is structurally `{ store, ip, secure }` — router's existing `Deps` is
assignable to it with no cast.

Routes claimed: `POST /api/run`, `GET /api/run/me`, `POST /api/next`,
`GET /api/board`, `POST /api/attest`, `POST /api/submit`. Wrong methods answer
405 from inside the dispatcher.

`/agents.txt` is **not** claimed — it needs to state the loop in §5 below.

Delete as planned: `/api/signup`, `/api/login`, `/api/logout`, `/api/me`,
`/api/solve/<key>`, `/api/progress/<key>`, and `server/auth.ts`. Nothing in my
files imports from `auth.ts`; the signing primitives it used to provide live in
`server/attest.ts` now (`hmac`, `b64url`, `sha256Hex`, `sameString`).

## 2. One thing I could not do: the share page needs the dialect

`GET /api/art/:shareId` currently calls `generatePuzzle(row.puzzle_key)` to
render the post-solve reveal. **That is now wrong** — it would show the base
generator's laws, not the laws the player actually fought. It must call:

```ts
import { dialectPuzzle } from "../shared/dialect";
const { puzzle } = dialectPuzzle(run.dialect, row.puzzle_key);
```

which needs `runs.dialect` on the row. `ArtRow` is currently
`RunSolveRow & { agent, model }`. Either add `dialect` to the `artByShare` /
`recentArt` joins, or call `runById(row.run_id)` first. **The salt must not
appear in the response body** — use it to derive the puzzle, then send only
`title`, `scheme`, `rules`, `bondPairs`, `parBonds`.

This is in `store.ts`/`router.ts`, both yours, so I left it alone.

## 3. `POST /api/run` returns a dialect *label*, not the salt

A deliberate deviation from CONTRACT §3, and the only one.

The contract says the response carries `dialect`. It does — as
`d-<8 chars>`, an HMAC-derived public name. It is **not** `runs.dialect`.
Returning the actual salt would let any client re-derive every law in the run,
which is the exact thing the dialect exists to prevent, and it would reopen the
wall-clock hole in THREAT-MODEL §"Wall-clock integrity" item 4. The label is
stable per run and fine for the benchmark table.

## 4. The difficulty band (stated explicitly, as asked)

`bandFor(idx)` in `runs.ts`. `keyAt` takes 48 bits off the front of the HMAC and
reduces it into the band, so the draw stays unpredictable while the *range* is
public.

| chain position | ladder band | tier |
| --- | --- | --- |
| 0 | L1–L3 | 0 |
| 1–2 | L4–L10 | 1 |
| 3–5 | L11–L25 | 2 |
| 6+ | L26 – `min(999999, round(25 × 1.35^(idx−5)))` | 3 |

The ceiling grows ~35% per puzzle and reaches the full ladder at about position
40. Measured: `6:[26,34] 10:[26,112] 20:[26,2254] 30:[26,45319] 40:[26,911217]
50:[26,999999]`. The floor stays at 26 so a long run keeps drawing from the
whole space instead of marching into a corner of it.

Collisions: `nextKey` checks the drawn key against every key this run has
already **banked** (one `runSolves` query) and re-hashes with a bump counter fed
back into the derivation string, so the retry is as deterministic and as
unpredictable as the first draw. Abandoned keys are not avoided — an abandoned
puzzle was never solved, so drawing it again costs the agent the work it dodged.

Every key is `L<1..999999>` and round-trips through `generatePuzzle()`; verified
across a 12-puzzle chain plus the band sweep.

## 5. The client: how feedback survives losing the rules

This is the part that matters most, so here is the exact shape.

**What breaks.** `src/game/usePuzzle.ts` currently calls `generatePuzzle(key)`
and `assess(key, board.grid)` on every animation frame. Both must go — they are
the extraction vector. `@shared/generate`, `@shared/validate` and
`@shared/rules` must no longer be reachable from the client bundle at all, or
none of this is worth anything.

**What survives, unchanged.** Both feedback channels and every pixel of the
rendering. `badCells` and `hotHues` keep their exact types (`Set<number>`,
`Set<number>`); `PixelCanvas` and `Palette` do not change. The 1.1 Hz red-black
flash and the swatch buzz are driven by the same two sets. **Only the source of
those sets changes** — from a local `assess()` call to the last `/api/attest`
response.

**The new loop.**

```
pointer up  →  push an event onto a local queue, mark the board dirty
              →  debounce ~250ms
              →  POST /api/attest { idx, nonce, receipt, events, art }
              →  response.feedback → { bad, hot, filled, empty, bonds, solved }
              →  badCells = new Set(indices where decodeGrid(bad)[i] === 0)
                 hotHues  = new Set(hot)
```

`bad` is a 4096-cell mask run-length encoded with the ordinary grid codec: `0`
where a cell should flash, empty elsewhere. `decodeGrid` from `@shared/codec`
decodes it — that module stays client-side, it is a codec and knows nothing
about laws. A clean board is about four bytes on the wire.

Keep the rAF loop for the *animation*; it should no longer recompute anything.
Between requests, keep rendering the last verdict — cells the player has since
repainted can simply be dropped from the flashing set optimistically.

**Event emission points** (`t`, plus `n` = cells touched, `d` = duration ms):

| DOM | event |
| --- | --- |
| pointerdown→pointerup on the canvas | `stroke` with `n` and `d` |
| a bucket/large fill committing | `paint` with `n` |
| hue or tool change | `pick` |
| undo | `undo` |
| `visibilitychange` / focus | `view` |
| click on the submit control | `intent` |

**Three constraints that will bite if missed:**

1. **Event `at` timestamps must be strictly non-decreasing across batches, not
   just within one.** The server compares the first event of a batch against the
   last `at` it has already attested. Queue events in emission order and never
   re-send one. (This cost me a debugging round; it is the one non-obvious rule.)
2. **Carry `receipt` and `nonce` from the previous `/api/attest` response** into
   the next request. The first pair for an issue comes from `POST /api/next` or
   `GET /api/board`. Reloading the page and re-fetching `/api/board` resets the
   tally to zero, which is a legitimate recovery path — it only makes the submit
   gate harder to clear, never easier.
3. **`art` is optional on the envelope.** Send it when the canvas changed; omit
   it to flush events during a pause and skip the assessment cost.

**Submit** posts `{ art, receipt, tokensIn?, tokensOut?, costMicro? }`. A 422
still carries `feedback`, so a rejected submit keeps teaching. A 403 means the
attestation gate was not met — surface its message, it is written to be read.

**Ergonomics, honestly.** Feedback becomes a round trip instead of a 0.17ms
local call, so the glow lands ~one network RTT after a stroke settles rather
than on the next frame. On a 250ms debounce this reads as "the board thinks for
a moment", which is acceptable and arguably better paced than instant. What is
*not* acceptable is per-frame feedback during a drag, and that is gone — the
debounce is not a nicety, it is the design.

**Drafts.** The `progress` table is gone with the user account, so
`localStorage` is now the only autosave. `usePuzzle`'s existing local draft path
already does this; just delete the `api.progress` / `api.saveProgress` calls.

## 6. Store: nothing needed

`createRun`, `runById`, `touchRun`, `openIssue`, `insertIssue`, `closeIssue`,
`nextIdx`, `bumpCalls`, `callCount`, `insertRunSolve`, `runSolves`, `solveAt`,
`attemptCount`, `noteAttempt` are all used exactly as landed. `runs.ts` types
its `store` as the real `Store` from `./store` — no local duplicates.

Run-creation throttling namespaces its key as `run:<ip>` in the `attempts`
table, so it cannot collide with any other user of that table.

`insertRunSolve` is called after a `solveAt` check with no transaction around
the pair, which is why the `ON CONFLICT DO NOTHING` and the select-fallback in
your SQL matter. Same reasoning as the old solve route.

## 7. For the BENCH agent

`issues.outcome = 'abandoned'` counts per run should appear in the benchmark
table. An agent may reroll a puzzle after a 60-second cooldown, so a run with a
fast median and many abandons is describing something other than its ability to
solve puzzles. See THREAT-MODEL "Known residuals".

`run_solves.events` is the attested event tally and `api_calls` is the
server-side round-trip count for that issue; both are authoritative and both are
reasonable secondary axes.

## 8. Tests

`shared/dialect.test.ts` adds 14 tests (~10s): salt validity, determinism,
the 160-combination solvability sweep, law-set divergence, the two
non-transfer attacks, and adversarial resistance to mechanical and solid fills.
Full suite: **109 pass, 0 fail**.

`server/runs.ts` and `server/attest.ts` have no test file — neither is on my
owned-files list. They were verified end-to-end against a fake `Store`
(register → issue → attest → feedback → gated submit → chain advance, plus
forged tokens, forged receipts, replayed receipts, uniform-timing rejection, and
the check that a *different accepted grid produces a different key(1)*). Worth
promoting into `server/runs.test.ts` by whoever owns that path.
