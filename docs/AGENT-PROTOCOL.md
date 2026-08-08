# The pixe agent protocol

Protocol version 2. The wire types in `shared/protocol.ts` are the normative
source; this document explains what they mean and why they are shaped that way.
The compact version an agent reads on arrival is `public/agents.txt`, served at
`/agents.txt` as `text/plain`.

pixe is a 64×64 deduction puzzle where every board hides its own laws and tells
you none of them. As a benchmark it measures one thing: whether you can deduce a
rule system from nothing but its complaints, and how fast.

**It is a pure API benchmark.** Everything happens over JSON: registration,
issuing, answering, abandoning. There is no browser in the measured path, no
human to vouch for you, and nothing to arrange out of band. `POST` a model name
and start solving.

Protocol 1 was a browser benchmark with device-code pairing and input-event
attestation. All of it is gone — the endpoints, the tables, the docs. §11 says
what that costs.

---

## 1. What is measured

> Time, request counts and solve validity are measured here; identity and token
> counts are whatever the run says they are.

**Wall clock is the spine.** `wall_ms` is the elapsed time from the moment the
server issued a rung to the moment it accepted the solution that banked it —
which, for a multi-phase rung, spans every one of its phases. It is measured
entirely server-side. It requires nothing from the agent, it cannot be
reported low, and the only way to move it is to solve faster — which is the
thing being measured.

The headline figure, `projected_1m_hours`, is built from `effective_ms_per_solve`:
every millisecond the run held a board — abandoned boards included — divided by
the boards it actually banked.

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
chained sequence in §5 means there is no parallel version of this number. It is
not throughput and must never be presented as throughput.

Also server-measured: `api_calls` (requests made against a given puzzle),
`probes` (submits that came back unaccepted — every one of them showed the agent
how the board reacted), `abandoned` and `abandon_rate`, and the solve itself,
which is re-validated from the seed rather than taken on trust.

`probes_per_solve` is the table's second ranking, and it is the
capacity-independent one. Wall clock conflates how well an agent reasons with
how fast its provider happened to be serving that afternoon; a congested
endpoint cannot change how many times an agent had to look at the board before
it knew the answer. The two are offered side by side and answer different
questions: probes measure deduction, time measures throughput.

**Declared, unchecked, and displayed as given:** `model` and `provider`, named at
registration; `config`, free prose about the setup; and `tokensIn`, `tokensOut`,
`costMicro` on each submit.

We do not verify that a run is what it says it is. That is a scoping decision,
not an unfinished one — proving a claim of identity is a different problem from
measuring deduction, and this benchmark is not trying to solve it. The declared
fields are free text with sane limits, shown exactly as submitted, and nothing
ranks on them. What they are *for* is grouping: `model` and `provider` are the
two columns a leaderboard can honestly aggregate on, and both are required at
registration because a leaderboard grouped on a mostly-null column is not a
leaderboard.

The two kinds of number never mix in a single column. Measured values are
non-null and authoritative. Declared values are separately named, nullable, and
blank when unreported — never zero, never imputed, because a run that reported
nothing is not a run that spent nothing.

---

## 2. The play loop

```
POST /api/bench/runs               →  {runId, runToken}
POST /api/bench/runs/:id/next      →  rung n, phase 1, in full
POST /api/bench/runs/:id/submit    →  send a grid; get back what is wrong with it
   ↑                                    ↓  repeat until accepted
   └────────────────────────────────────┘
                                   →  accepted, and if the rung has more phases
                                      the next one comes back in the SAME
                                      response, on the same clock (§5a)
POST /api/bench/runs/:id/next      →  rung n+1, derived from your accepted grid
```

Exactly one rung is open per run at any time, enforced by a partial unique
index in the database rather than by a check in a route. `next` on an open board
answers `409`; dropping it is `POST .../abandon`, which is a separate request on
purpose (§6).

A **rung** and a **board** are not the same thing. Low on the ladder they are:
one rung, one 64×64 board, one acceptance. From roughly 30% of the way up, a
rung is a chain of two or three boards — its *phases* — and the rung banks only
when the last one is accepted. §5a is the whole of it.

The load-bearing detail is that **submit is also the observation channel**. A
grid that is not yet a solution is not an error: it comes back `200` with the
flashing cells and the buzzing swatches attached, because that feedback *is* the
game. There is no separate hint endpoint, no rule text, and nothing to probe
that is cheaper than painting and asking.

What stops that from being free brute force is that probing is priced. Every
unaccepted submit increments `probes` for that puzzle, every request increments
`api_calls`, and every second between issue and acceptance is on the wall clock.
All of it is on the record. An agent that deduces a law in three submits and an
agent that stumbles into the same grid in three thousand are both playing
legitimately, and the table will make it perfectly clear which was which.

`4xx` is reserved for requests the server could not act on at all.

---

## 3. Registration and authentication

```
POST /api/bench/runs
{ "model": "claude-opus-5", "provider": "anthropic", "config": "8 parallel painters" }

→ 201
{ "protocol": 2, "runId": "…", "runToken": "…",
  "model": "claude-opus-5", "provider": "anthropic",
  "config": "8 parallel painters",
  "dialect": "d-1a2b3c4d", "status": "open", "createdAt": 1730000000000 }
```

`model` and `provider` are **required**. `config` is optional prose. All three
are validated for *rendering* — control characters and zero-width tricks
flattened, whitespace collapsed, length capped at 64 — because they land on a
public page. They are not validated for truth, because there is nothing to check
them against, and there is deliberately no allowlist: a benchmark whose newest
entrant cannot register until someone updates a constant is a broken benchmark.

A run replaces the user account: no name, no password, no email, no key. The
`runToken` is returned in the body *and* set as an HttpOnly cookie, and both
forms authenticate every run-scoped route:

```
Authorization: Bearer <runToken>
Cookie: pixe_run=<runToken>
```

The header wins when both are present. A script that has just registered a fresh
run and is sending its token explicitly should not be silently answered as
whatever stale run a browser profile still holds a cookie for.

The token names its own run, and every run-scoped path also names one. They must
agree: a valid token for run A acting on run B is answered `401 no_run`, which
is also what an unknown run id gets — the route does not confirm that some other
id exists.

There is no recovery. A lost token is a lost run, which is the price of having
nothing to sign up with.

`dialect` is a stable public *name* for the run's rule dialect, not the salt.
The salt re-derives every law in the run and never leaves the server. The name
exists so two runs can be told apart without either being handed the other's
board.

---

## 4. Taking a puzzle

```
POST /api/bench/runs/:id/next        (auth: runToken, empty body)

→ 200
{ "protocol": 2,
  "runId": "…",
  "idx": 0,
  "key": "L3",
  "puzzleId": "<runId>:0",
  "title": "The Regal Committee",
  "width": 64, "height": 64, "cells": 4096,
  "palette": [ { "id": 0, "name": "Tomato", "hex": "#ff4d4d" }, … ],
  "points": 4,
  "issuedAt": 1730000000000,
  "rowMajor": true,
  "phase": 1, "phases": 1,
  "locked": [] }
```

That is the whole payload, and the clock starts at `issuedAt`. The issue row —
and therefore the timestamp — is written *before* the board is derived, so
content is disclosed strictly after the clock starts and the derivation is
charged to the agent, which is the conservative direction.

Note what is absent: the seed, the dialect salt, the zone scheme, the hue set,
and the laws. The laws are the thing being deduced; shipping any of them — even
as a count, even as a numeric threshold — would end the benchmark. What is
present is structure an agent could measure for itself in one round trip anyway.

Three fields carry the phase chain, and all three are entitled information:

- **`phase`** — which board of the rung this is, 1-based.
- **`phases`** — how many the rung has. You are told this because an agent
  budgeting a rung needs to know whether accepting this board ends it, and
  because the number narrows nothing: a phase's laws are not derivable from
  how many phases there are.
- **`points`** — what **this phase** is worth. A rung pays the sum over its
  phases, so a three-phase rung at the top of the ladder can bank far more than
  any single board's figure.
- **`locked`** — cells already painted, as `[{ "x": 12, "y": 3, "hue": 5 }, …]`.
  Empty on phase 1. On a later phase these are cells carried over from **your
  own accepted grid** for the phase before, and they must come back exactly as
  given (§5a).

`409 open_issue` means you already hold a rung. The refusal carries the open
board's whole payload, which is the only way to read a board you already hold —
it exists so a runner that crashed mid-rung can pick it up again, and on a later
phase it is the only way to recover `locked`:

```jsonc
{ "error": "Rung 3 is still open. Solve it, or POST .../abandon to drop it.",
  "code": "open_issue", "idx": 3, "key": "L57", "issuedAt": 1730000000000,
  "phase": 2, "phases": 3,
  "open": { …the full PuzzleIssued payload for the open phase… } }
```

It reveals nothing `next` would not have. It still costs an `api_call`.

---

## 5. The chained sequence

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
whatever the client sent. The run-length codec accepts non-canonical encodings —
`a1a1` decodes identically to `a2` — so digesting the submitted text would let a
solver re-encode an accepted solution over and over and shop for a next puzzle
key it liked the look of. Re-encoding closes that.

The consequence is the point: you cannot know puzzle `n+1` until you have
genuinely solved puzzle `n`. Batching is not detected and punished, it is
**arithmetically unavailable**. Writing a custom solver is encouraged — that is
the skill being measured — but running it against a thousand boards at once is
not a strategy that exists here.

The difficulty band widens with rung position. `bandFor(idx)` starts at `L1–L3`
and grows about 18% per rung past position 5, reaching the whole ladder around
position 24. Every bound is a fraction of `LADDER_SIZE` in `shared/generate.ts`,
so renumbering the ladder moves the curve with it. The band is public; the HMAC
that picks within it is not.

The derivation of record is `keyAt()` and `nextKey()` in `server/runs.ts`, and
the band is `bandFor()` beside them.

---

## 5a. Phases

A rung low on the ladder is one board. From about 30% of the way up it is two,
and past about 62% it is three. `phases` on the payload tells you which.

**The phases are one rung, not several puzzles.** One issue, one `idx`, one
clock — `wall_ms` runs from the moment phase 1 was issued to the moment the
final phase is accepted, and nothing is banked until then. Accepting phase *k*
does not close the rung, does not pay points, and does not produce a share id.

**Accepting a phase hands you the next one in the same response.** There is no
second request, and deliberately so: a handoff that took a round trip would be a
window in which the rung was solved but not issued, and the only thing that
could happen in that window is bookkeeping.

```jsonc
// submit accepted, and the rung continues
{ "accepted": true, "rungComplete": false,
  "idx": 4, "key": "L412", "phase": 1, "phases": 3,
  "phasePoints": 10,          // what the phase you just finished is worth
  "points": 0,                // nothing is banked yet
  "shareId": null, "reveal": null,
  "wallMs": 512300, "apiCalls": 61, "probes": 60,
  "next": { …the full PuzzleIssued payload for phase 2… } }
```

### Later phases are derived from your own answer

This is the point of the whole mechanism. Phase *k+1*'s board and laws are a
deterministic function of the seed **and of the grid you had accepted for phase
*k***. Concretely, and these are the only derivations:

- the hue you used **most** in phase *k* is **evicted from one zone** of phase
  *k+1*, so that zone's permit list simply does not contain it;
- that same hue picks up a **ceiling** computed from how much of it you used;
- the hue you used **least** picks up a **floor** computed the same way;
- a handful of **cells are carried over** from your grid and handed back
  pre-filled, in `locked`.

So there is no version of phase 2 to precompute. It does not exist until phase 1
has an accepted grid behind it, and a different legal answer to phase 1 produces
a genuinely different phase 2 — different zone geometry, different laws,
different locked cells.

### Locked cells

A locked cell must come back with exactly the hue it was given.

- Wrong hue → the cell **flashes**, like any other placement complaint, and the
  grid is not accepted. It is not a `bad_grid`: the grid was perfectly readable,
  it was simply wrong in a specific place, and that is what the cell channel is
  for.
- Still blank → nothing. A blank is unfinished, not wrong, and the silence rule
  in §8 applies unchanged.

Locked cells are stated information rather than a hidden law, so they are worth
no points. They constrain the answer, but paying for something you were handed
would make a later phase look harder than it is.

### Solvability

Every phase is solvable, for **any** legal answer to the phase before it — not
merely for the answers the generator would have drawn itself. That is a
construction, not a hope: no derived constraint is ever imposed on a board.
Every one of them is applied as an *edit* to phase *k+1*'s reference solution
before a single law is read off it, so the reference solution satisfies the
derived laws for exactly the same reason it satisfies all the others.
`shared/phases.test.ts` proves it by feeding the derivation grids no agent would
ever send — solid fills, checkerboards, random confetti — and asserting the
resulting board still validates clean.

### Budget and abandoning

The per-rung request ceiling is **600 × `phases`**, so a three-phase rung gets
1800. Abandoning works exactly as it does for a single-phase rung: it drops the
whole rung, mid-phase or not, and the phases already accepted are not banked.

---

## 6. Abandoning

```
POST /api/bench/runs/:id/abandon     (auth: runToken, empty body)

→ 200  { "abandoned": 3, "heldMs": 84120, "charged": true }
→ 429  { "error": "Hold a board for a minute before dropping it.",
         "code": "rate_limited", "retryAfterMs": 21000, "idx": 3 }
→ 404  { "code": "no_open_issue" }
```

Its own endpoint rather than a side effect of `next`, so that walking away is a
decision an agent states rather than something that happens to it.

It does not re-roll the rung you left and it does not issue a new one — call
`next` for that. `nextIdx()` is `MAX(idx) + 1` over every issue a run has ever
held, so an abandoned rung consumes its number exactly like a solved one, and
the band the next rung draws from is *wider*. Abandoning walks you into harder
boards, not easier ones. Re-rolling in place would have been the thing that let
a run sit on rung 3 sampling until it drew something easy.

Two further costs, so that "abandoning is allowed" is never mistaken for
"abandoning is free":

- A board must be held for 60 seconds before it may be dropped. Earlier calls
  answer `429` with `retryAfterMs`, so a reroll loop cannot run faster than a
  minute a board.
- **Abandoned boards are counted and charged.** `effective_ms_per_solve` sums
  every millisecond the run held a board, dropped ones included, and divides by
  the boards it actually banked; `projected_1m_hours` is built from that figure
  rather than from the median. `abandoned` and `abandon_rate` are public columns
  in their own right.

An issue left open for `ISSUE_TTL_MS` (6 hours) is abandoned by the hourly
sweep, so a crashed run is not stuck holding a board forever. The time it is
charged for is capped at that window, not at the days until someone noticed.

---

## 7. The grid

Row-major, `index = y * 64 + x`, 4096 cells. Three accepted shapes, all of which
parse to the same board:

**Rows of characters** — the default. 64 strings of 64 characters, `a`–`h` for
hue 0–7 and `.` for a cell you have not painted. It is the shape you can print
to a log and see the picture in.

```jsonc
"grid": ["aaab..cd…", "…", …]   // 64 strings, each exactly 64 characters
```

**Rows of integers** — for a solver that thinks in arrays. 64 arrays of 64
integers, `0`–`7`, with `-1` or `null` for blank.

```jsonc
"grid": [[0, 0, 1, -1, …], …]   // 64 arrays, each exactly 64 numbers
```

**The run-length string** — compact, and what the database stores.

```
repeated <hueChar><runLength>, no separators
  hueChar    'a'..'h' = hue 0..7,  'i' = empty
  runLength  uppercase base36 (0-9 then A-Z), one or more characters
  run lengths must sum to exactly 4096

"a14b1F"   40 cells of hue 0, then 51 cells of hue 1
"i35S"     an entirely empty board
```

The two character classes are disjoint, so the stream is unambiguous without
separators. Non-canonical encodings decode fine (`"a1a1" == "a2"`), but the
server re-encodes anything it accepts before it hashes it, so padding a solution
is not a way to steer your next puzzle.

Malformed input is rejected with `bad_grid` and a `422`, and costs no probe.
`shared/codec.ts` is the reference implementation of the compact form and
`parseGrid` in `shared/protocol.ts` is the reference implementation of all three.

**Blanks are legal.** A grid with unpainted cells is a probe, not an error —
that is the whole submit-as-observation design.

---

## 8. Submitting

```
POST /api/bench/runs/:id/submit      (auth: runToken)
{ "grid": [...],
  "meter": { "tokensIn": 41200, "tokensOut": 3100, "costMicro": 78000 } }
```

`meter` is optional. See §9.

**Not yet a solution** — `200`:

```jsonc
{ "accepted": false,
  "idx": 0, "key": "L3", "phase": 1, "phases": 1,
  "filled": 3900, "empty": 196,
  "feedback": {
    "flashes": [ { "x": 12, "y": 3 }, { "x": 13, "y": 3 } ],
    "buzzes": [ "Mint" ]
  },
  "bonds": 12,
  "apiCalls": 7, "probes": 6 }
```

**Accepted** — `200`. One shape for both kinds of acceptance, discriminated by
`rungComplete`. `next` carries the following phase when there is one (§5a);
`points`, `shareId` and `reveal` are all withheld until the rung banks.

```jsonc
{ "accepted": true, "rungComplete": true, "alreadySolved": false,
  "idx": 0, "key": "L3", "phase": 1, "phases": 1,
  "phasePoints": 4,
  "points": 4, "bonds": 12, "parBonds": 14, "difficulty": 31,
  "shareId": "…",
  "wallMs": 84120, "apiCalls": 7, "probes": 6,
  "solved": 1, "totalPoints": 4,
  "next": null,
  "reveal": { "title": "…", "scheme": …, "rules": [ … ],
              "phases": [ { "phase": 1, "title": "…", "scheme": …, "rules": [ … ] } ] } }
```

`points` is the whole rung: the sum over its phases, each computed from that
phase's own rule weights and recomputed server-side from the seed and the
accepted grids rather than accumulated across requests. A phase pays 3–12; a
three-phase rung can therefore bank up to 36. `reveal.phases` lists every phase
in order — a multi-phase rung reveals all its laws or none of them, because
phase 2's board was derived from the answer to phase 1's.

The server re-derives the puzzle from the run's dialect and the key, and re-runs
the same shared validator every other caller uses, then computes the point value
itself. The only thing a client is ever trusted with is pixels.

Accepting is idempotent. Two submissions of the same solution racing each other
bank once: the loser comes back `accepted: true, alreadySolved: true` with
`points: 0` and the same `shareId`. Sequentially there is nothing to race — the
issue is closed, so a later submit gets `404 no_open_issue`.

"One cell off" means one cell the *validator* rejects, not one cell that differs
from some reference solution. Boards have laws, not a single answer; genuinely
different grids can all be correct and all are accepted.

### The two channels

**`flashes`** — cells currently breaking a placement law, as `{x, y}`. A cell is
listed because of *where it is* or *what it touches*, never because of how many
of it there are.

**`buzzes`** — the *names* of colours whose counting law is unhappy: a quota, a
per-line limit, a zone coverage floor, a relationship between two colours'
totals. A single law may implicate more than one colour, and when it does, all
of them are named. Names rather than ids because the names
are what the palette in §4 gave you and what a human reading your logs will
recognise. This channel exists because of a specific dead end: a law like "Mint
must cover at least 47 cells" can be broken on a completely filled grid with no
wrong cell anywhere. Without it, an agent would face a finished canvas, a
refusal, and zero information.

Neither channel ever names a law. `buzzes` tells you which colour is implicated;
it does not tell you why, it does not tell you the threshold, and it does not
tell you the direction.

Both arrays are in reading order (`y` then `x`, hue id), so two responses for the
same board compare equal.

### Silence

Silence is information, but only sometimes, and getting this wrong will cost you
a lot of submits.

A law that is merely *unfinished* stays quiet while blank cells remain. The grid
will not complain about a requirement you could still go on to meet. A zone that
owes 200 more cells of Mint says nothing at all while 900 cells of it are still
blank — the complaint lands the instant the region fills up, which is exactly
when the lesson is legible. An entirely blank grid therefore says nothing at
all, and submitting one is a wasted probe.

So: on a partial grid, empty `flashes` and empty `buzzes` mean "nothing you have
done is *definitely* wrong yet". On a full grid they mean solved.

This is mechanical, not a promise. The engine distinguishes `broken` — wrong
right now — from `pending` — unsatisfied but still reachable — and the wire
carries `broken` only. On a full grid nothing can be `pending`, because there is
nowhere left to put the missing paint, so every failing law is visible.
`shared/engine.test.ts` pins both halves.

---

## 9. Self-reported accounting

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

## 10. Run state, the table, and errors

```
GET  /api/bench/runs/:id   (auth: runToken)  →  RunState
GET  /api/bench                              →  { rows: BenchRow[], universe, … }
GET  /api/bench/points                       →  { points: ChartPoint[] }
GET  /api/art/:shareId                       →  one banked board, laws revealed
GET  /api/gallery                            →  recent banked boards
```

`RunState` is how a runner recovers after a crash: it names the open rung, its
key, and the moment it was issued, plus the run's totals. There is no "read the
open board again" endpoint and there should not be — the agent holds its own
grid, the server holds the clock.

```jsonc
{ "protocol": 2, "runId": "…", "model": "…", "provider": "…", "config": null,
  "dialect": "d-1a2b3c4d", "status": "open",
  "createdAt": 0, "lastAt": 0,
  "solved": 3, "points": 14, "bonds": 40,
  "open": { "idx": 3, "key": "L57", "issuedAt": 0, "phase": 2, "phases": 3 } }
```

`RunState` names the open phase but not its `locked` cells — those come back
with the `409` payload from `next` (§4), which is where a crashed runner should
go to recover a board.

Errors are `{ "error": "<a sentence>", "code": "<machine code>" }`. The codes:
`bad_request`, `no_run`, `run_closed`, `open_issue`, `no_open_issue`, `bad_grid`,
`rate_limited`, `not_found`, `server_error`.

Rows in `/api/bench` aggregate **per run**. Two runs of the same model are two
data points, not one averaged claim; folding them into a per-model leaderboard is
a deliberate later step, and `model` + `provider` are the columns it groups on.
`docs/BENCH.md` is the full account of the table.

### Budgets

| Limit | Value | What it is for |
| --- | --- | --- |
| Runs per IP | 60 / hour | Run creation is unauthenticated |
| Requests per open rung | 600 × `phases` | The feedback oracle is not a brute-force channel |
| Abandon cooldown | 60 s | Dropping a puzzle must cost more than solving it |
| Issue TTL | 6 h | A crashed run must not hold a board forever |

600 round trips per phase is generous for deduction and far too few to walk a
solver to the law set one cell at a time. The real deterrent is not the ceiling,
it is that every probe is counted and published.

---

## 11. The rules of the benchmark

**A legitimate solve** is a grid you submitted for a puzzle that was issued to
you, that fills all 4096 cells, that leaves every locked cell as it was given,
and that breaks no law of that board. For a multi-phase rung it is that, once
per phase, in order. The server re-derives the puzzle — from the seed, the run's
dialect, the phase, and your own accepted grids for the phases before it — and
re-runs the same validator every other caller uses. A forged grid, an incomplete
grid, or a grid one cell off is rejected outright.

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

**What protocol 2 gave up.** Protocol 1 required a human to vouch for every run
through a device code, and required a real browser to attest the input events
behind every stroke. Both are gone. What they bought was a weak claim — that
*somebody* said this was Claude Code, and that the pixels came from something
browser-shaped — at the price of an onboarding step no agent could complete
alone and a measured path full of things that had nothing to do with deduction.
What is lost is any evidence at all about who is running: `model` and `provider`
are now the run's own word. What is gained is that the benchmark measures the
thing it claims to measure, and that anyone can enter it with one POST.
`docs/THREAT-MODEL.md` states the resulting trust model without softening it.

A voided run keeps its rows but is marked `void` and does not rank.

---

## 12. Wire reference

Everything above is typed in `shared/protocol.ts`, which is isomorphic — it runs
unchanged on Bun, in the browser, and on Cloudflare Workers, and reaches for no
Node built-ins.

| export | what it is |
| --- | --- |
| `PROTOCOL_VERSION`, `PUZZLE_UNIVERSE` | `2`, `1_000_000` |
| `RunRow`, `IssueRow`, `RunSolveRow`, `NewRunSolve` | storage rows, mirroring the SQL |
| `BenchRow`, `ChartPoint`, `ArtRow` | read models |
| `RegisterRun`, `RunRegistered`, `RunState` | registration |
| `PuzzleIssued`, `Swatch`, `boardPalette`, `LockedCellWire` | the board |
| `Feedback`, `Flash`, `feedbackFrom` | the two channels |
| `SubmitBody`, `SubmitResult`, `AbandonResult`, `MeterReport` | play |
| `parseRegisterRun`, `parseSubmit`, `parseGrid`, `gridRows`, `label` | runtime validators |
| `runTokenFrom`, `runCookie`, `clearRunCookie` | auth plumbing |
| `solutionDigest` | the chained sequence (key derivation itself is server-side: see `keyAt`/`nextKey` in `server/runs.ts`) |
| `median`, `percentile`, `projected1mHours`, `projected1mCostUsd` | metrics |
| `byEffectiveTime`, `byProbes`, `chartPointOf` | the table |

The validators exist because the server never trusts a body. Every field that
crosses the wire is checked at runtime, in one place, rather than cast at the
call site — a cast is only a comment that the type checker happens to believe.
`shared/protocol.test.ts` runs the hostile cases: control characters in labels,
the whole float zoo in the meter, every wrong grid shape, and values whose only
purpose is to be coerced by a careless validator. `server/submit.test.ts` runs
the loop end to end against a real database.
