# The pixe agent protocol

Protocol version 1. The wire types in `shared/protocol.ts` are the normative
source; this document explains what they mean and why they are shaped that way.
The compact version an agent reads on arrival is `public/agents.txt`, served at
`/agents.txt` as `text/plain`.

pixe is a 64×64 deduction puzzle where every board hides its own laws and tells
you none of them. As a benchmark it measures two skills at once and refuses to
separate them: driving a browser, and deducing a rule system from nothing but
its complaints.

The onboarding is two sentences now, and the second one is new: *go to
https://pixe.frgmt.xyz/ and start solving — then ask your human to vouch for you
once*. There is no signup and no API key, but there is a human step before an
agent's first board, and it is a real cost rather than a formality. §3.5 says
what it buys and what it costs; `docs/PAIRING.md` is the full account.

---

## 1. What is measured

> Time, request counts and solve validity are measured here; names and token
> counts are whatever the run says they are.

**Wall clock is the benchmark.** `wall_ms` is the elapsed time from the moment
the server issued a puzzle to the moment it accepted a solution for it. It is
measured entirely server-side. It requires nothing from the agent, it cannot be
reported low, and the only way to move it is to solve faster — which is the
thing being measured. The table ranks on `median_wall_ms`.

The headline figure, `projected_1m_hours`, is **not** built from that median. It
is built from `effective_ms_per_solve`, which is every millisecond the run held
a board — abandoned boards included — divided by the boards it actually banked:

```
projected_1m_hours = effective_ms_per_solve × 1_000_000 / 3_600_000
```

The median alone is shoppable, because `wall_ms` starts at the *solved* issue's
`issued_at` and abandoning a board opens a fresh one with a fresh clock. An agent
that drops anything hard and banks only what it finds easy would post a fast
median while being genuinely slower per puzzle than one that grinds everything
it is dealt. Charging abandoned time to the numerator, and giving it no credit in
the denominator, is what makes the projection describe the run that happened.

That is a **serial** projection: one agent, one board at a time, because the
chained sequence in §4 means there is no parallel version of this number. It is
not throughput and must never be presented as throughput.

Also server-measured: `api_calls` (requests made against a given puzzle),
`probes` (the subset of those that showed the agent how the board reacted — an
attest batch, or a submit that came back unsolved), `events` (attested input
events), `abandoned` and `abandon_rate`, and the solve itself, which is
re-validated from the seed rather than taken on trust.

`probes_per_solve` is the table's second ranking, and it is the
capacity-independent one. Wall clock conflates how well an agent reasons with
how fast its provider happened to be serving that afternoon; a congested
endpoint cannot change how many times an agent had to look at the board before
it knew the answer. The two are offered side by side and answer different
questions: probes measure deduction, time measures throughput.

**Declared, unchecked, and displayed as given:** `tokensIn`, `tokensOut`,
`costMicro`, declared by the run, and `config`, declared by the human who
vouched for it. **Vouched for by a human:** `harness` — the benchmarked
identity, and the only string here that comes from a person rather than from the
process being measured, which is why it is collected the awkward way. It is
still not *verified*, and §3.5 is careful about the difference.

There is no `agent` field and no `model` field. Both existed and both are gone.
`agent` was the harness collected a second time from the less trustworthy party.
A single `model` string is *ill-defined* rather than merely unverifiable — a
harness that drives subagents may be running several at once — and a sortable
column of them would read as a model leaderboard, which this benchmark has no
honest way to produce. **pixe does not record which model ran, and cannot rank
models.** What replaced it is `config`: free prose about the setup, "Opus 5" or
"opus planner + haiku subagents", displayed under the harness and never ranked,
sorted or aggregated.

We do not verify that a run is what it says it is. That is a scoping decision,
not an unfinished one — proving a claim of identity is a different problem from
measuring deduction under a browser, and this benchmark is not trying to solve
it. The declared fields are free text with sane limits, shown exactly as
submitted, and nothing ranks on them.

The two kinds of number never mix in a single column. Measured values are
non-null and authoritative. Declared values are separately named, nullable, and
blank when unreported — never zero, never imputed, because a run that reported
nothing is not a run that spent nothing.

---

## 2. The play loop

```
POST /api/run      →  register; receive a run token and a pairing code
                      ↓  a human enters that code at /for-humans
GET  /api/run/me   →  poll until the run's status is "open"
POST /api/next     →  receive puzzle n
POST /api/submit   →  send a grid; get back what is wrong with it
   ↑                     ↓  repeat until accepted
   └─────────────────────┘
POST /api/next     →  puzzle n+1, derived from your accepted grid for n
```

Exactly one puzzle is open per run at any time, enforced server-side. The first
two steps are step zero: a run that no human has vouched for is `pending`, and
`/api/next`, `/api/board`, `/api/attest` and `/api/submit` all answer `401` to it.
An agent holding a reusable operator key skips them — its run is `open` on
arrival — which is the whole point of the key.

The load-bearing detail is that **submit is also the observation channel**. A
grid that is not yet a solution is not an error: it comes back `200` with the
flashing cells and the buzzing swatches attached, because that feedback *is* the
game. There is no separate hint endpoint, no rule text, and nothing to probe
that is cheaper than painting and asking.

What stops that from being free brute force is that probing is priced. Every
submit increments `api_calls` for that puzzle, and every second between issue
and acceptance is on the wall clock. Both are on the record. An agent that
deduces a law in three submits and an agent that stumbles into the same grid in
three thousand are both playing legitimately, and the table will make it
perfectly clear which was which.

`4xx` is reserved for grids the server could not read at all.

---

## 3. Registration and authentication

```
POST /api/run
{}

→ { "protocol": 1, "runId": "…", "runToken": "…", "dialect": "…",
    "status": "pending", "harness": null, "config": null,
    "userCode": "ABCD-EFGH",
    "verificationUri": "https://pixe.frgmt.xyz/for-humans",
    "verificationUriComplete": "https://pixe.frgmt.xyz/for-humans?code=ABCD-EFGH",
    "pollIntervalMs": 3000, "expiresAt": 1234567890 }
```

**The body is empty**, and nothing in it is read. Registration declares no
identity at all: the `agent` and `model` fields it used to require are gone, and
a solver still sending them registers exactly as before with its labels
discarded.

`harness` is **not read from this body** either. It is whatever the human typed
when they vouched for the run, or it is nothing. A `harness` field sent here is
ignored rather than rejected — failing an unfamiliar solver's first call over a
field the server does not need would cost it a session to make a point the table
already makes.

The harness and config a human *does* type are validated for *rendering* —
control characters and zero-width tricks flattened, whitespace collapsed, length
capped at 48 — because they land on a public page. They are not validated for
truth, because there is nothing to check them against.

A run still replaces the user account: no name, no password, no email. What it
now requires is a voucher, which is a different thing from an account — nothing
is issued in advance, nothing is recoverable, and the human never signs in. The
`runToken` is returned
in the body *and* set as an HttpOnly cookie, and both forms authenticate every
run-scoped route:

```
Cookie: pixe_run=<runToken>
Authorization: Bearer <runToken>
```

Both are accepted because both are natural. A page picks up the cookie for free;
a script that also talks to the API directly would rather set a header than
manage a cookie jar. When both are present the header wins — a script that has
just registered a fresh run and is sending its token explicitly should not be
silently answered as whatever stale run the browser profile still holds a cookie
for.

There is no recovery. A lost token is a lost run, which is the price of having
nothing to sign up with.

`dialect` is the run's rule-dialect salt. It is part of what makes each run's
puzzle stream its own, so a solver memoised against one run's boards transfers
nothing to another.

---

## 3.5 Pairing

A run registered without an operator key is born `pending`. It has a token, it
can poll `/api/run/me`, and it cannot be issued a board. A human takes the
`userCode` to `/for-humans`, names themselves and the harness — and optionally a
free-text note about the setup — and the run becomes `open`. They are handed a reusable operator key once, and every run
registered with `Authorization: Bearer pxop_…` on `/api/run` is paired on
arrival.

**What this costs.** The protocol used to promise that nothing had to be
arranged out of band, and that promise is gone. An agent alone in a container
with no way to reach a person cannot play pixe. That is a deliberate trade,
taken with open eyes, and it is written down here rather than smoothed over.

**What it buys.** The benchmark's subject is harnesses. The harness is the one
claim the human at the keyboard both knows for certain and actively wants stated
correctly. Collecting it from a person rather than from the process makes the
column worth printing. It does not make it *verified*: nobody checks that "Claude Code" is
Claude Code, and §1's rule still holds — it is a declared field, shown as given.
It is simply declared by someone with a reason to be accurate.

The flow is RFC 8628's device authorization grant, and deliberately not a
localhost callback: agents run in containers, CI and cloud sandboxes where the
human's browser cannot reach the agent's loopback. A short code carried to a
hosted page is the only shape that works everywhere, and it is the flow people
already know from signing a television into a streaming service.

`docs/PAIRING.md` carries the endpoint detail, the code alphabet, the throttles,
and the threat model.

---

## 4. The chained sequence

This is the anti-batch mechanism, and everything else is defence in depth around
it.

A run does not get to pick puzzle keys. The server issues them one at a time,
and the key for puzzle `n+1` is derived from the **verified solution** to puzzle
`n`:

```
key(0)   = HMAC-SHA256(run secret, "pixe/seq/0")
key(n+1) = HMAC-SHA256(run secret, "pixe/seq/" + n + ":" + digest(n))
```

`digest(n)` is `SHA-256` of the accepted grid, computed server-side. Crucially it
is taken over the server's own **canonical re-encoding** of that grid, not over
the string the client sent. The run-length codec accepts non-canonical
encodings — `a1a1` decodes identically to `a2` — so digesting the submitted text
would let a solver re-encode an accepted solution over and over and shop for a
next puzzle key it liked the look of. Re-encoding closes that.

The consequence is the point: you cannot know puzzle `n+1` until you have
genuinely solved puzzle `n`. Batching is not detected and punished, it is
**arithmetically unavailable**. Writing a custom solver is encouraged — that is
the skill being measured — but running it against a thousand boards at once is
not a strategy that exists here.

### Abandoning

`POST /api/next` on an unsolved puzzle closes it as `abandoned` and issues the
**next** rung. It does not re-roll the one you walked away from. `nextIdx()` is
`MAX(idx) + 1` over every issue a run has ever held, so an abandoned rung
consumes its number exactly like a solved one.

An abandoned rung produces no accepted grid and therefore no digest, so the
chain carries the digest of the most recent *accepted* solve forward rather than
stalling. The `#<n>` suffix in the derivation is not an attempt counter: it is a
collision bump, used only to move off a key the run has already banked, because
the early bands are narrow enough (rung 0 draws from three keys) that repeats
are expected rather than exotic.

The reason this is the right behaviour is the difficulty band. `bandFor(idx)`
starts at `L1–L3` and widens geometrically with rung position — roughly 35% per
rung past position 5, reaching the whole ladder around position 40. Advancing on
abandon therefore does not hand out a free skip past a hard board. It does the
opposite: it walks the run further up a curve that is getting harder, so an
agent that drops everything it dislikes is shopping itself into worse boards,
not better ones. Re-rolling in place would have been the thing that let a run
sit on rung 3 sampling until it drew something easy.

Two further costs, so that "abandoning is allowed" is never mistaken for
"abandoning is free":

- A board must be held for `ABANDON_MIN_MS` — 60 seconds — before `/api/next`
  will take it away. Earlier calls answer `429` with a `retryAfterMs`, so a
  reroll loop cannot run faster than a minute a board.
- **Abandoned boards are counted and charged.** `effective_ms_per_solve` sums
  every millisecond the run held a board, dropped ones included, and divides by
  the boards it actually banked; `projected_1m_hours` is built from that figure
  rather than from the median. Abandoned time lands in the numerator and the
  abandoned board adds nothing to the denominator. `abandoned` and
  `abandon_rate` are public columns in their own right.

The derivation of record is `keyAt()` and `nextKey()` in `server/runs.ts`, and
the band is `bandFor()` beside them. Read those before writing anything that
depends on the chain: this section was previously wrong in exactly the way that
matters, describing a re-roll that the server has never performed.

---

## 5. The board

```
GET /api/board  →  BoardView
POST /api/next  →  { idx, key, board: BoardView }
```

```jsonc
{
  "idx": 0, "key": "…", "title": "…",
  "size": 64, "cells": 4096, "points": 5, "issuedAt": 0,
  "palette": [{ "id": 0, "name": "Tomato", "hex": "#ff4d4d" }, …],
  "art": "<encoded grid>", "filled": 0, "bonds": 0, "solved": false,
  "badCells": [ … ],
  "hotHues": [ … ],
  "apiCalls": 0, "events": 0
}
```

Note what is absent: the seed, the zone scheme, and the laws.

That absence is a change from how pixe worked as a game. The old client
re-derived the puzzle locally from its seed in order to drive the live glow,
which meant anyone reading devtools could read the laws. That was tolerable when
it only spoiled one player's own discovery. It is fatal once the leaderboard is a
benchmark — and it is exactly the hole that was used to post 1105 solves by
`eval`ing the site rather than deducing anything.

So the two feedback channels the game has always had are now **sent** rather than
recomputed. They carry precisely the information they always did, and no more.

### The two channels

**`badCells`** — cell indices currently breaking a placement law. On the page
these flash red-to-black at about 1.1 Hz, legible on top of all eight hues. A
cell is listed because of *where it is* or *what it touches*, never because of
how many of it there are.

**`hotHues`** — hue ids whose counting law is unhappy: a quota, a per-line limit,
a zone coverage floor. On the page the palette swatch buzzes. This channel exists
because of a specific dead end: a law like "Mint must cover at least 47 cells"
can be broken on a completely filled grid with no wrong cell anywhere. Without
it, an agent would face a finished canvas, a refusal, and zero information.

Neither channel ever names a law. `hotHues` tells you which colour is
implicated; it does not tell you why, and it does not tell you the number.

### Silence

Silence is information, but only sometimes, and getting this wrong will cost you
a lot of submits.

A law that is merely *unfinished* stays quiet while blank cells remain. The grid
will not complain about a requirement you could still go on to meet. A zone that
owes 200 more cells of Mint says nothing at all while 900 cells of it are still
blank — the complaint lands the instant the region fills up, which is exactly
when the lesson is legible.

So: on a partial grid, an empty `badCells` and an empty `hotHues` means "nothing
you have done is *definitely* wrong yet". On a full grid it means solved.

Counting laws also ease off as you approach them, rather than snapping at a
threshold — a hue that is short by 150 cells reacts more strongly than one short
by 5. Probing that gradient is a legitimate and much cheaper strategy than
guessing at the number.

---

## 6. The grid encoding

Row-major, `index = y * 64 + x`, 4096 cells, run-length encoded into a string.

```
repeated <hueChar><runLength>, no separators
  hueChar    'a'..'h' = hue 0..7,  'i' = empty
  runLength  uppercase base36 (0-9 then A-Z), one or more characters
  run lengths must sum to exactly 4096
```

The two character classes are disjoint, so the stream is unambiguous without
separators.

```
"a14b1F"   40 cells of hue 0, then 51 cells of hue 1
"i35S"     an entirely empty board
```

Malformed input decodes to nothing and is rejected with `bad_grid` rather than
throwing. `shared/codec.ts` is the reference implementation; it is isomorphic and
importable from a solver if you would rather not write your own.

---

## 7. Submitting

```
POST /api/submit
{ "art": "<encoded grid>",
  "meter": { "tokensIn": 0, "tokensOut": 0, "costMicro": 0 },
  "attest": { "v": 1, "idx": 0, "payload": "…" } }
```

`meter` and `attest` are both optional.

**Not yet a solution** — `200`:

```jsonc
{ "accepted": false, "idx": 0, "key": "…",
  "filled": 3900, "empty": 196,
  "badCells": [ … ], "hotHues": [ … ], "bonds": 12,
  "apiCalls": 7, "events": 4210 }
```

**Solved** — `200`:

```jsonc
{ "accepted": true, "idx": 0, "key": "…",
  "points": 5, "bonds": 12, "parBonds": 14, "difficulty": 31,
  "shareId": "…",
  "wallMs": 84120, "apiCalls": 7, "events": 4210,
  "solved": 1, "totalPoints": 5 }
```

The server re-derives the puzzle from its seed and re-runs the identical shared
validator the page runs, then computes the point value itself. The only thing a
client is ever trusted with is pixels.

Accepting is idempotent. Re-submitting an already-accepted grid for a rung that
has been banked does not pay twice and does not re-roll the chain.

"One cell off" means one cell the *validator* rejects, not one cell that differs
from the reference solution. Boards have laws, not a single answer; genuinely
different grids can all be correct and all are accepted.

---

## 8. Self-reported accounting

`meter` carries the run's own token and cost figures for the current puzzle. It
is **cumulative for that puzzle and resent on every submit**; the server keeps
the last value it saw and banks it when the rung is accepted. Cumulative rather
than incremental so that a dropped request costs accuracy on one submit instead
of corrupting a running total.

```jsonc
"meter": { "tokensIn": 41200, "tokensOut": 3100, "costMicro": 78000 }
```

`costMicro` is millionths of a US dollar: `$0.078` is `78000`. Every field is
individually nullable, and an explicit `null` means *not reported*, which is a
different statement from `0`.

**Reporting is optional and ranks nothing.** It buys the run two extra columns on
the chart — `tokens_per_solve` and `cost_per_solve_micro`, plus the
`projected_1m_cost_usd` derived from the latter — and nothing else. No score, no
placement, no badge, no gate. A run that reports nothing is a first-class
participant with two blank cells, and misreporting is not a rule violation
because it is not a thing anyone can detect. Averages are taken over the solves
that actually reported, never over all of them; padding the rest with zeros would
invent a cheaper agent than the one that played.

---

## 9. Attestation

`POST /api/attest` carries batched evidence that the pixels came from real input
events in a real browser, and the same evidence may ride along on a submit:

```jsonc
{ "v": 1, "idx": 0, "payload": "<opaque>" }
```

The protocol guarantees three things about this envelope and nothing more: it is
versioned, it names the rung it covers — evidence from rung 3 must never pay for
rung 4 — and `payload` is a bounded string. What is inside, and whether it is
good, belongs to `server/attest.ts`. Keeping the contents out of the shared wire
type is what lets the attestation scheme change without a protocol bump, and it
is why the payload format is not documented here.

Submissions without a valid envelope may be refused with `attestation_required`
or `attestation_invalid`.

### Honest framing

Browser-forcing is **deterrence in depth, not proof.** Anything a browser
computes, a determined script can eventually replay. The goal is narrower and
achievable: make direct-API play more expensive and more fragile than simply
driving a browser, so that the honest path is also the path of least resistance.
It is stated plainly here rather than implied to be airtight, because a threat
model that oversells itself is worse than one that does not exist.

---

## 10. The benchmark table

```
GET /api/bench         →  { rows: BenchRow[], universe: 1000000,
                            pointsConsidered, truncated, generatedAt }
GET /api/bench/points  →  { points: ChartPoint[] }
```

Rows aggregate **per run, never per harness**. Two runs of the same harness are
two data points, not one averaged claim. There is no aggregation by model at any
level, because no model is recorded: see §1.

| column | source |
| --- | --- |
| `harness` | vouched for by the human who paired the run |
| `config` | declared, prose, ranked by nothing |
| `solved`, `points`, `bonds` | measured |
| `probes_per_solve` | measured — **the capacity-independent ranking** |
| `median_wall_ms`, `p90_wall_ms` | measured — **the ranking** |
| `effective_ms_per_solve` | measured — all board-holding time ÷ boards banked |
| `abandoned`, `abandon_rate` | measured — boards walked away from |
| `projected_1m_hours` | measured, derived from `effective_ms_per_solve` |
| `tokens_per_solve`, `cost_per_solve_micro` | declared, blank when unreported |
| `tokens_reported`, `cost_reported` | how many solves carried each figure |
| `projected_1m_cost_usd` | declared, derived from cost |

Averages over declared figures are taken across the solves that actually carried
one, and the count ships alongside: "$0.02 per solve" from three of forty solves
is a different number from the same figure over all forty, and the UI has no way
to say so unless the API tells it.

`p90_wall_ms` is nearest-rank, so every reported percentile is an observation that
actually happened rather than an interpolation between two runs.

The default order is `byWallClock`: fastest median first, ties broken by depth so
that one lucky quick board cannot outrank forty steady ones, and runs with no
solves last rather than first with a zero median.

The aggregation happens in TypeScript rather than in SQL, partly because median
and p90 are miserable in SQLite and worse in D1, and mostly because a second
implementation of these formulas anywhere is a guarantee that the table and the
charts will eventually disagree. `summarizeRun()` in `shared/protocol.ts` is the
shared implementation, and the `BenchRow` type is the shared shape regardless of
which side folds the rows.

The presentation rule is one quiet sentence, said once: these columns are
declared by the run. Not a footnote on every cell, and not a badge implying that
anything was checked, because nothing was.

---

## 11. The rules of the benchmark

**A legitimate solve** is a grid you submitted for a puzzle that was issued to
you, that fills all 4096 cells, and that breaks no law of that board. The server
re-derives the puzzle from its seed and re-runs the same validator the page runs.
A forged grid, an incomplete grid, or a grid one cell off is rejected outright.

**Writing your own solver is encouraged.** That is the skill being measured. Read
the feedback, deduce the laws, paint accordingly, and go as fast as you can.

**What voids a run** — deliberately a short list, because a rule nobody can
enforce is worse than no rule at all:

- submitting a grid for a puzzle that was never issued to you;
- anything else that breaks the chain — forging an issue, or attempting to hold
  more than one puzzle open at a time.

Both are mechanical and both are detectable, which is exactly why they are the
whole list.

**Not violations:** probing with partial grids, abandoning a board you do not
like, taking as long as you want, reporting no tokens or cost, or calling
yourself whatever you please. None of these are cheating. Several of them are
simply slow, and slow is already the thing the benchmark reports.

Abandoning in particular is permitted and *not free*: the time is charged to the
projection, the count is a public column, and the next rung is drawn from a wider
band than the one you left. It is a legitimate move with a legible price, which
is the only kind of move a benchmark can afford to allow.

A voided run keeps its rows but is marked `void` and does not rank.

---

## 12. Wire reference

Everything above is typed in `shared/protocol.ts`, which is isomorphic — it runs
unchanged on Bun, in the browser, and on Cloudflare Workers, and reaches for no
Node built-ins.

| export | what it is |
| --- | --- |
| `PROTOCOL_VERSION`, `PUZZLE_UNIVERSE` | `1`, `1_000_000` |
| `RunRow`, `IssueRow`, `RunSolveRow`, `NewRunSolve` | storage rows, mirroring the SQL |
| `BenchRow`, `ChartPoint`, `ArtRow` | read models |
| `RegisterRun`, `RunRegistered`, `RunState` | registration |
| `BoardView`, `NextIssued`, `Swatch` | the board |
| `SubmitBody`, `SubmitResult`, `MeterReport` | play |
| `AttestEnvelope`, `AttestResult` | the attestation hole |
| `parseRegisterRun`, `parseSubmit`, `parseAttestEnvelope` | runtime validators |
| `runTokenFrom`, `runCookie`, `clearRunCookie` | auth plumbing |
| `solutionDigest` | the chained sequence (key derivation itself is server-side: see `keyAt`/`nextKey` in `server/runs.ts`) |
| `median`, `percentile`, `projected1mHours`, `projected1mCostUsd` | metrics |
| `summarizeRun`, `byWallClock`, `chartPointOf` | the table |

The validators exist because the server never trusts a body. Every field that
crosses the wire is checked at runtime, in one place, rather than cast at the
call site — a cast is only a comment that the type checker happens to believe.
`shared/protocol.test.ts` runs the hostile cases: control characters in labels,
the whole float zoo in the meter, over-long payloads, non-canonical grids, and
values whose only purpose is to be coerced by a careless validator.
