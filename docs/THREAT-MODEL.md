# pixe threat model

This document exists because the last version of the anti-cheat section was
honest about its trade-off and still got beaten. It is written to be useful
after an attack, not reassuring before one. Where a layer is deterrence rather
than proof, it says so in those words. Where there is no layer at all any more,
it says that too.

## What pixe is now

A pure API benchmark. An agent registers over JSON, is issued one puzzle at a
time over JSON, and answers over JSON. There is no browser in the measured path,
no human vouching for a run, and no attestation of anything.

That is a deliberate weakening of the previous trust model, and this document is
where the bill comes due. Read §"What was removed and what it cost" before
quoting any number from a pixe table as evidence about a named model.

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
second is arithmetic. Both fixes survive the move to a pure API benchmark
unchanged, which is why that move was affordable at all.

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
tomorrow, the benchmark would still measure serial solving. Most of them have
been.

### What it does not do

It does not make any individual solve harder, slower, or more honest. A solver
that beats a board in 400ms of pure computation still beats it in 400ms. The
chain constrains *throughput*, not *method* — and constraining method is not a
goal. Writing a custom solver is the skill being measured.

## What is measured rather than claimed

Everything that ranks a run is computed on the server from things the server
watched happen:

- **Wall clock.** `issues.issued_at` to the moment a grid passed the validator.
  It cannot be reported low because it is never reported at all.
- **Probes.** Submits that came back unaccepted, counted in the `issues` row.
  An agent cannot look at the board without the counter moving, because looking
  at the board *is* submitting to it.
- **`api_calls`.** Every request against an open issue.
- **Abandonment.** Duration and outcome per issue, so `effective_ms_per_solve`
  can charge a run for the boards it dropped.
- **The solve itself.** Re-derived from the run's dialect and re-validated with
  the same shared engine every other caller runs. A client is trusted with
  pixels and with nothing else.

These are the columns a leaderboard should rank on, and they are the only ones
that survive an adversarial reading.

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

### Withholding the rules from the client

`POST /api/bench/runs/:id/next` returns the chain index, the key, the title, the
point value, the grid dimensions and the palette. It does not return the seed,
the dialect salt, the zone scheme, the rules, or `hueSet`. Feedback is computed
server-side and returned as flashing coordinates plus the names of implicated
hues. `RuleEval.progress` is deliberately not forwarded, because its `need`
field is the literal numeric threshold of a counting law.

Feedback is also filtered to `broken` verdicts only. A `pending` rule — one that
is unsatisfied but still reachable — says nothing while blanks remain. That is
the silence rule the protocol documents, and it is enforced in
`server/runs.ts:feedbackFor` rather than promised in prose. It is not a security
property; it is the difference between a benchmark that teaches and one that
nags.

What this costs an attacker: the laws are no longer computable offline. The only
way to learn them is to probe the board and read the reactions — which is the
game.

What it does not do: **whatever the server will tell anyone, it will tell a
script.** The feedback response is a plain JSON oracle by design. Withholding
the rules converts an offline computation into an online, counted, serial
interrogation. It does not make the rules secret.

### Budgets

| Limit | Value | What it is for |
| --- | --- | --- |
| Runs per IP | 60 / hour | Run creation is unauthenticated |
| Requests per open issue | 600 | The feedback oracle is not a brute-force channel |
| Abandon cooldown | 60 s | Dropping a puzzle must cost more than solving it |
| Issue TTL | 6 h | A crashed run must not hold a board forever |
| Request body | 256 KB | A 64-row JSON grid is ~8 KB |

600 round trips is generous for deduction and far too few to walk a solver to
the law set one cell at a time. The budget exists to bound brute force, not
deduction — deduction through feedback *is* the game. The real deterrent is that
every probe is counted and published, so brute force does not go undetected, it
goes on the record as a bad probe count.

## Verified runs

This is a narrow addition, and it is written here in the same register as
everything above it: what it proves, what it costs an attacker, and what it
does not do.

**The mechanism.** `POST /api/bench/runs` accepts an optional
`X-Pixe-Verified-Key` header. If it equals this deployment's `PIXE_VERIFIED_KEY`
— compared with `sameString` in `server/crypto.ts`, constant-time — the run is
created with `verified = 1`. `PIXE_VERIFIED_KEY` is read from Bun's process env
locally and from the Workers secret in production (`bunx wrangler secret put
PIXE_VERIFIED_KEY`); it is never sent to a client, never logged, and never
appears in any response body — the registration response echoes back a
`verified: true|false` boolean, never the key it was checked against.

**What a wrong key does.** Nothing observable. A missing header, a wrong key,
and no key configured on this deployment at all produce the identical
response: `201`, `verified: false`. Registration never fails on identity, so
the endpoint cannot be turned into an oracle for guessing the key by anyone
probing it with wrong guesses — every guess looks exactly like no guess.

**What this proves.** Precisely one thing: whoever sent this registration
request held this deployment's own secret. The secret is never distributed —
it lives in an env var on whatever machine or Worker runs `PIXE_VERIFIED_KEY`
and nowhere else — so in practice the only party who can produce it is the
maintainer, running the benchmark themselves. `verified` is a vouch about
*where the run was started*, full stop.

**What this does not prove.** That the declared `model` is accurate. That the
run's harness behaved honestly for the rest of its life — the header is
checked once, at registration, and nothing about `next`, `submit` or `abandon`
depends on it. That a verified run is a *better* run in any sense the server
can measure — `wall_ms`, probes and solves are exactly as trustworthy on an
unverified run, because they were never the part that needed vouching for.
Nobody should read `verified` as "this model definitely produced these
pixels" — read it as "the maintainer started this one personally", which is a
narrower and more honest claim.

**A deployment with no key configured** — a fork, a local dev server, a clone
someone stood up without setting the secret — can never mark anything
verified, for anyone, including a request that happens to send the right
string for some *other* deployment's key. There is no default key and no
fallback: an absent `PIXE_VERIFIED_KEY` means an absent capability, not a
weaker one.

**How the table uses it.** `GET /api/bench` groups runs by `(model, provider)`
and picks one representative per group — see `docs/BENCH.md`. If a group has
any verified run, the representative is chosen from among the verified ones
only, even if an unverified sibling in the same group banked far more. That
rule is absolute, not a tiebreak: letting a bigger unverified number stand in
for a model whenever it was more flattering would make the badge decorative.

## Wall-clock integrity

Wall clock per solve, measured server-side from `issues.issued_at` to
acceptance, is the spine of the benchmark. It cannot be moved downward by lying,
so the question is whether it can be moved downward by working on a puzzle
before its clock starts. Every path:

1. **`POST .../next`** writes the issue row — and therefore `issued_at` — and
   *then* derives the board. Content is disclosed strictly after the timestamp,
   and the ~30ms of derivation is charged to the agent, which is the
   conservative direction.
2. **`GET .../runs/:id`** serves only the row returned by `openIssue`. There is
   no parameter for a future index, and no route that names a puzzle at all.
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

## What was removed, and what it cost

Three layers existed in protocol 1 and none of them exist now. This section is
the honest accounting, written so that nobody has to reconstruct it from a git
log.

**Device-code pairing** (`server/pairing.ts`, `operators`, `pair_codes`). A
human typed a code into a web page and named the harness the agent was running
under. It bought one weak claim: that *some person* was willing to say "this is
Claude Code". It cost an onboarding step no agent could complete alone — an
agent in a container, in CI, or in a cloud sandbox with nobody watching could
not play at all. That was fatal for a crowd-sourced benchmark, and the claim it
bought was never verified anyway.

**Input-event attestation** (`server/attest.ts`). A signed, chained receipt of
typed interaction events, with a write ledger that had to *replay* into the grid
being submitted. Its own documentation said plainly what it was worth: it was no
evidence at all about who or what moved the pointer, and a script willing to
decompose its solution into legal painting operations satisfied every check —
`attest.test.ts` contained a test that did exactly that and asserted it passed.
What it actually bought was serialisation of the feedback oracle. That property
is now obtained more simply and more honestly: the oracle *is* the submit
endpoint, one open puzzle at a time, every call counted.

**Execution binding** (`server/exec-bind.ts`). A challenge-response over pixels
read back from the page's own canvas. It was observe-only from the day it
shipped and was never turned into a gate, because the rate at which it fired on
honest clients was never measured. It is gone unmeasured, which is the right
outcome for a check nobody could show was safe to enforce.

**What all of that cost, in one sentence:** pixe lost the ability to make any
claim about *who or what* is answering — not that a human was involved, not
that a browser was involved, not that the declared model is the model. `model`
and `provider` are the run's own word about itself and nothing more. "Verified
runs" above is a later, much narrower addition on top of this — a vouch about
where a run was *started*, not a restoration of anything this section
describes losing. It does not make `model` or `provider` any less the run's
own word.

**What it bought:** anyone can enter with one POST; the measured path contains
only deduction and latency; and the parts of the system that were always the
real guarantees — the chain, the server-side clock, the counted probes, the
server-side re-validation — are unchanged.

## Known residuals

Listed because they are real, not because they are handled.

**Identity is unverified by default, and stays that way for almost every run.**
`model`, `provider` and `config` are free text typed by the run. Nothing checks
them against reality, and nothing will — see "Verified runs" above for the one
narrow exception, which is a vouch about where a run started, not a check on
whether its label is true. A run can still claim to be any model at all, and
the overwhelming majority of rows on the table are exactly that: a claim,
taken at its word, `verified` or not. **A pixe leaderboard is a leaderboard of
runs that claimed to be a model** — some of them started by the maintainer, most
of them not — and any presentation that blurs that is misrepresenting this
document. The measured columns are honest about *what happened*; the label on
a row is still not evidence of *who did it*.

**Parallel runs.** Run creation is cheap and unauthenticated, so one operator
can spawn many concurrent runs and publish only the luckiest. Bounded, not
prevented: 60 runs per IP per hour; per-run dialects mean concurrent runs share
no work, so `k` runs cost `k` times the compute rather than amortising; and
median-over-many-puzzles washes out most single-board luck. The residual is that
an operator with many IPs can cherry-pick a better median. The cost of a better
number scales linearly with the number of runs — it does not batch — which is
the same shape as the guarantee everywhere else here.

**Abandonment shopping.** An agent may abandon an issue after 60 seconds and
draw another, which lets it dodge boards it finds slow and lower its median. The
cooldown makes this cost more than most solves, the next band is wider rather
than narrower, and `effective_ms_per_solve` charges the dropped time. Abandons
are recorded as `issues.outcome = 'abandoned'` and the count is a public column,
because a run with many abandons and a fast median is describing something other
than its ability to solve puzzles.

**The feedback oracle.** A scripted client interrogates the board exactly as
intended. This is accepted: an oracle the player can interrogate is the entire
teaching design, and removing it would remove the game. It is bounded by the
600-request ceiling and priced by the probe counter.

**The post-solve reveal** leaks that board's law set, which is a partial view of
the dialect. Marginal, since the agent deduced those laws in order to solve it,
and each key gets an independently seeded perturbation.

**Human play.** The web UI is now an ordinary client of the same API, so a
person painting by hand is a run like any other and is timed like any other.
There is no separate path and no attempt to tell the two apart.

## Out of scope

**Identity.** Covered above and worth repeating in the shortest form: `model`
and `provider` are never checked against reality, and never will be.
`verified` is a narrow exception to *provenance*, not to this — it says who
started the run, never whether the run's own description of itself is true.

**Tokens and cost.** Self-reported, optional, unverifiable, and never blended
with server-measured fields. `run_solves.tokens_in`, `tokens_out` and
`cost_micro` are nullable precisely so an unreported value stays distinguishable
from a reported zero, and every surface that shows them must label them
unverified. Everything that ranks anything — points, bonds, difficulty,
`wall_ms`, `api_calls`, `probes` — is computed server-side.
