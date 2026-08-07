# pixe threat model

This document exists because the last version of the anti-cheat section was
honest about its trade-off and still got beaten. It is written to be useful
after an attack, not reassuring before one. Where a layer is deterrence rather
than proof, it says so in those words.

## The incident

Someone posted **1105 solves in record time**. They did not deduce a single
law. The client re-derived every puzzle locally from its seed in order to drive
the live glow — a trade-off the README named and accepted — so the attack was:

1. `eval` the site, pull out `shared/generate.ts` and `shared/rules.ts`.
2. For any key `L<n>`, regenerate the puzzle and its reference solution offline.
3. `POST /api/solve/<key>` for a thousand keys, concurrently.

Every individual submission was legitimate. The server validated real pixels
against real laws and accepted grids that genuinely satisfied them. Nothing was
forged. The leaderboard was still meaningless, because the thing it ranked —
how many boards you can beat — had a cost of zero per board and no serialisation
anywhere in the system.

Two independent failures, and it matters that they are independent:

- **Disclosure.** The rules were computable from data the server handed out.
- **Concurrency.** Nothing forced puzzle `n` to precede puzzle `n+1`.

Fixing only the first is a losing game — obfuscation always is. Fixing the
second is arithmetic.

## What is genuinely unforgeable

**One thing.** Everything else on this page is cost imposed on an attacker, not
a proof about one.

### The chained puzzle sequence

A run does not choose puzzle keys. The server issues them one at a time:

```
key(0)   = HMAC(run_secret, "pixe/seq/0")
key(n+1) = HMAC(run_secret, "pixe/seq/" + n + ":" + solutionDigest(n))
```

`solutionDigest(n)` is SHA-256 over the *canonicalised grid the server
accepted*. `run_secret` is 256 bits, generated server-side, stored in
`runs.secret`, and never sent anywhere — the run token is an HMAC *output*, not
the key that produced it.

So computing puzzle `n+1` requires two things an attacker cannot have: a secret
that never leaves the database, and a solution that does not exist until a grid
has passed the validator. Combined with `issues_one_open` — a partial unique
index, so it cannot be raced the way a `SELECT`-then-`INSERT` can — a run has
exactly one puzzle in flight, always.

The 1105-solve attack is not detected here. It is not punished. **It cannot be
expressed.** A thousand puzzles requires a thousand accepted solutions in
sequence, which is the same thing as solving a thousand puzzles.

This is the load-bearing guarantee. If every other layer below were removed
tomorrow, the benchmark would still measure serial solving.

### What it does not do

It does not make any individual solve harder, slower, or more honest. A solver
that beats a board in 400ms of pure computation still beats it in 400ms. The
chain constrains *throughput*, not *method* — and constraining method is not a
goal. Writing a custom solver is the skill being measured.

## What is deterrence, priced in effort

### Per-run rule dialects

`shared/dialect.ts` perturbs the reference solution with a 128-bit per-run salt
and re-derives every law from the perturbed grid. Hooking in there rather than
anywhere later preserves the generator's one real invariant — the reference
solution is built first, the laws are read back off it — so a dialect puzzle is
provably solvable by construction, and `shared/dialect.test.ts` sweeps 160
puzzle × dialect combinations to confirm it.

What it costs an attacker: a solver memoised against one run transfers nothing
to another. The tests assert this as an attack rather than a statistic — one
dialect's accepted target never satisfies another dialect's laws, and neither
does the base generator's own solution for the same key, which anyone holding a
copy of `generate.ts` can compute in 17ms.

What it does not do: the salt is not protected by cryptography. `Rng` is
mulberry32 seeded by a 32-bit FNV-1a hash — the generator's existing primitive,
not a PRF. An attacker who has fully solved a board could in principle search
the 2^32 seed space for the stream that produced it. The consequence is bounded
rather than absent: each phase seed is a function of `(salt, key, tag)`, so
recovering one board's stream yields neither the salt nor anything about the
next board. It is not, and should not be described as, a cryptographic secret.

### Browser-event attestation

`server/attest.ts` requires a signed envelope of typed interaction events —
strokes with cell counts and durations, tool picks, undos, visibility changes, a
submit intent — before a grid can be banked. The gate is 8 strokes, 24 events, a
3-second span, one submit intent, and a tally no older than two minutes.

Two honest notes on that gate. First, it is tuned to sit *below* any plausible
honest session rather than above an implausible forged one: a gate that rejects
real play breaks the benchmark, while one a script can clear merely fails to
improve it. Second, `MIN_SPAN_MS` is deliberately only 3 seconds, because wall
clock is the headline metric and a meaningful floor here would be a floor on the
number being measured.

Those counts are the weak half and always were. Two things carry weight.

#### The receipt chain — serialisation

There is no table for per-issue counters, so the running tally lives in an
HMAC-signed receipt the client carries. Each batch presents the previous receipt
and receives a new one with the tally advanced. Consequences:

- Forging a higher tally requires the run secret.
- Replaying an old receipt only *rewinds* you, which never helps.
- A thousand concurrent batches all chained from receipt zero produce a thousand
  tallies of one. There is no operation that merges them. A tally of a thousand
  costs a thousand sequential round trips.

That is real serialisation, obtained the same way the puzzle chain gets it.

#### The write ledger — the envelope has to contain the answer

Every attested event carries the exact cells it wrote and what it wrote there.
The receipt carries the canvas those writes have built up so far — the whole
grid, run-length encoded, not a digest of it, because the server has to be able
to *apply* the next batch to something and a Worker isolate has nowhere else to
keep it. Each batch is then checked by **replaying** it: the writes applied to
the receipt's canvas must produce, cell for cell, the grid the client is asking
feedback on. At submit, the grid being banked must equal that same replayed
canvas.

Both halves matter, and for different reasons.

The attest-time half means the feedback oracle is no longer free. Feedback is
the entire teaching mechanism — it is the thing every solver must call
constantly — and you cannot now ask about a board you did not paint. A probe is
an act of painting or it is a 409.

The submit-time half means the envelope has to *contain the answer*. Before
this, an envelope was content-free ceremony: emit eight plausible strokes about
nothing in particular, then post a grid computed by other means. Now the strokes
and the grid are the same object, checked by arithmetic.

What that buys, stated as narrowly as it deserves: **a submission must be
accompanied by a stroke history that genuinely produces it.** Nothing more.

What it does not buy: **it is no evidence whatsoever about who or what moved the
pointer.** A script that decomposes its solution into legal painting operations
and posts them in order satisfies every check in the file. `attest.test.ts` has
a test that does exactly that and asserts it passes, so the residual cannot be
quietly forgotten. What the ledger costs such a script is that the
decomposition, the ordering, the intermediate canvases and the serial round
trips all become mandatory — which is very nearly the cost of driving the page,
and driving the page produces all of it for free. That is the entire claim.

#### No plausibility heuristics, on purpose

An earlier version of this file rejected four identically-spaced events in a
row, on the theory that a hand on a mouse does not do that. **That check is
gone, and nothing like it is coming back.**

The intended players drive the site with Playwright or Puppeteer, headless
included. `page.mouse.move()` produces perfectly uniform inter-event timing,
integer coordinates, linear interpolation and no jitter — every "does this look
like a real hand?" signal fires *hardest* on precisely the clients this
benchmark exists for. A check that penalises them is strictly worse than no
check: it does not merely fail to catch a forger, it makes the benchmark
unusable for its actual audience, and it does so silently until somebody
complains. Looking human is not the property this system wants, so it does not
measure it. The replacement measures arithmetic instead: either the strokes on
record paint the grid or they do not, and a laggy VM, a 30Hz display, a
touchscreen and a headless Chromium all answer that question identically.

#### Residuals in this layer, specifically

- **A forged stroke history is still a valid stroke history.** Priced above.
- **A reload starts a fresh ledger.** `GET /api/board` hands out a receipt over
  a blank canvas, so a restored local draft arrives as one bulk write in the
  next event. That is the honest account — those cells really were unattested —
  but it does mean the ledger proves "these strokes paint this grid", never
  "this grid took this long to paint".
- **The submit-side grid rides in the receipt string.** `POST /api/submit` hands
  attestation nothing but the receipt, so the client appends the canvas it is
  spending it on: `<receipt>!<grid>`. `bindReceipt` is the shape this wants;
  the suffix goes away when `runs.ts` can pass the decoded grid instead.
- **Nothing surfaces on the board yet.** The tally now carries `writes` and
  `filled` alongside the event counts. Neither has a column.

### Withholding the rules from the client

`GET /api/board` returns the chain index, the key, the title, the point value,
the grid size, and an attestation receipt. It does not return the seed, the zone
scheme, the rules, or `hueSet`. Feedback is computed server-side and returned as
a run-length-encoded 4096-cell mask plus a list of implicated hues.
`RuleEval.progress` is deliberately not forwarded, because its `need` field is
the literal numeric threshold of a counting law.

What this costs an attacker: the laws are no longer computable offline. The only
way to learn them is to probe the board and read the reactions — which is the
game.

What it does not do: **whatever the browser can see, a scripted HTTP client can
also decode.** The feedback response is a plain JSON oracle and any client can
call it. Withholding the rules converts an offline computation into an online,
rate-limited, serial interrogation. It does not make the rules secret.

### Budgets

| Limit | Value | What it is for |
| --- | --- | --- |
| Runs per IP | 20 / hour | Run creation is unauthenticated |
| Round trips per issue | 600 | The feedback oracle is not a brute-force channel |
| Abandon cooldown | 60s | Rerolling a puzzle must cost more than solving it |

600 round trips is generous for play and far too few to walk a solver to the law
set one cell at a time. The budget exists to bound brute force, not deduction —
deduction through feedback *is* the game.

## Wall-clock integrity

Wall clock per solve, measured server-side from `issues.issued_at` to
acceptance, is the headline metric and the default ranking. It cannot be moved
downward by lying, so the question is whether it can be moved downward by
working on a puzzle before its clock starts. Every path:

1. **`POST /api/next`** writes the issue row — and therefore `issued_at` — and
   *then* derives the board. Content is disclosed strictly after the timestamp,
   and the ~30ms of derivation is charged to the agent, which is the
   conservative direction.
2. **`GET /api/board`** serves only the row returned by `openIssue`. There is no
   parameter for a future index.
3. **Computing `key(n+1)` early** requires the run secret and the digest of an
   accepted grid. Neither exists before the submit for `n` completes.
4. **Pre-solving the candidate band.** The difficulty band is public and narrow
   early — position 10 draws from 87 candidate keys. Without per-run dialects
   this would be a genuine vulnerability: an agent could generate all 87 boards
   in advance and have the answer waiting. It is closed because generating any
   of them requires the dialect salt, which is never shipped. **The dialect is
   what makes it safe to narrow the band**, which is worth stating plainly since
   the band exists for benchmark quality rather than for security.
5. **The post-solve reveal** describes the board just banked. The next key is
   unreachable from it regardless of what the agent learns.

No path found. This is the claim most worth re-checking whenever a route is
added: any endpoint that answers a question about a puzzle other than the open
one reopens it.

## Known residuals

Listed because they are real, not because they are handled.

**Parallel runs.** Run creation is cheap and unauthenticated, so one operator
can spawn many concurrent runs and publish only the luckiest. Bounded, not
prevented: 20 runs per IP per hour; per-run dialects mean concurrent runs share
no work, so `k` runs cost `k` times the compute rather than amortising; and
median-over-many-puzzles washes out most single-board luck. The residual is that
an operator with many IPs can cherry-pick a better median. The cost of a better
number scales linearly with the number of runs — it does not batch — which is
the same shape as the guarantee everywhere else here.

**Abandonment shopping.** An agent may abandon an issue after 60 seconds and
draw another from the same band, which lets it dodge boards it finds slow and
lower its median. The cooldown makes this cost more than most solves. Abandons
are recorded as `issues.outcome = 'abandoned'`; **the benchmark table should
show the abandon count per run**, because a run with many abandons and a fast
median is describing something other than its ability to solve puzzles.

**The feedback oracle.** A scripted client can call `/api/attest` exactly as the
browser does — it now has to paint the board it is asking about, but a script
willing to emit a legal stroke history can still do that. The 600-call budget
bounds it. This is accepted: an oracle the player can interrogate is the entire
teaching design, and removing it would remove the game.

**The post-solve reveal** leaks that board's law set, which is a partial view of
the dialect. Marginal, since the agent deduced those laws in order to solve it,
and each key gets an independently seeded perturbation.

**Rule extraction from a live page.** An agent that drives a real browser sees
exactly what a player sees. That is the intended shape of play, not an attack.

## Out of scope

**Identity.** `harness` is free text typed by the human who vouched for the run,
and `config` is their free prose about the setup. Neither will ever be verified.
Nothing ranks on `config`, and `harness` ranks nothing either — it labels the
rows that the measured columns rank. No model is recorded anywhere, so there is
no model claim to verify and no model ranking to defend.

**Tokens and cost.** Self-reported, optional, unverifiable, and never blended
with server-measured fields. `run_solves.tokens_in`, `tokens_out` and
`cost_micro` are nullable precisely so an unreported value stays distinguishable
from a reported zero, and every surface that shows them must label them
unverified. Everything that ranks anything — points, bonds, difficulty,
`wall_ms`, `api_calls`, `events` — is computed server-side.
