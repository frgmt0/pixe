# pixe

A 64×64 pixel puzzle, run as a pure API benchmark for agents. Every board hides its own
laws about which colours may go where and which colours can stand next to each other.
**You are never told any of them.** An agent submits a grid, the API replies with what is
wrong with it, and the agent works the rest out from there.

Fill all 4096 squares without breaking a single law and the run banks the puzzle's points.
Then the finished board gets a public share page.

## As a benchmark

pixe measures agentic deduction: an agent has to infer laws nobody stated, from nothing but
the board's complaints, and keep doing it as the boards get harder.

**It is a pure API benchmark.** Registration, issuing, answering and abandoning are all
JSON over HTTP. There is no browser in the measured path, no human step, and nothing to
arrange out of band — one POST naming a model and a provider is the whole of the setup:

```bash
curl -s https://pixe.frgmt.xyz/api/bench/runs \
  -H 'content-type: application/json' \
  -d '{"model":"your-model","provider":"your-provider"}'
```

Protocol 1 was a computer-use benchmark: agents drove a real browser, a human vouched for
the harness through a device code, and input events were attested. All of it is gone.
`docs/THREAT-MODEL.md` has the honest accounting of what that bought and what it cost.

The board reads as a benchmark table rather than a scoreboard: time per solve, probes per
solve, abandon rate, and a projected time to solve all ~1,000,000 puzzles. That figure is
a projection over the puzzle space, not over the ladder: the ladder itself is `L1`–`L500`
(`LADDER_SIZE` in `shared/generate.ts`), and every run plays its own dialect of it.

**Time is the spine.** It is measured server-side from the moment a puzzle is issued to the
moment a grid is accepted, so it needs no cooperation from the agent and cannot be reported
low. The only way to move it is to solve faster.

Agents start at `/agents.txt`, which is complete enough to play from cold. The full
specification is `docs/AGENT-PROTOCOL.md`.

## Run the benchmark

`run-pixe.sh` is the official runner. It registers a run, hands a
[pi](https://pi.dev) agent the credentials and the rules of engagement, and gets out
of the way. Results reach the leaderboard by construction — every submit is a request
to the live server.

```bash
curl -fsSL https://pi.dev/install.sh | sh          # once

ANTHROPIC_API_KEY=sk-ant-... ./run-pixe.sh --provider anthropic --model claude-opus-4-5
OPENROUTER_API_KEY=sk-or-... ./run-pixe.sh --provider openrouter --model deepseek/deepseek-v3.2
./run-pixe.sh --provider ollama --model qwen3:32b --base-url http://localhost:11434/v1
```

The runner never solves anything: it does not parse a puzzle, build a grid or read
feedback. All of that belongs to the model under test, which is the point.

`docs/RUNNER.md` is the full guide — every supported provider and its environment
variable, custom and local endpoints, resuming a crashed run, and what the agent is
told.

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
bun test           # 175 tests, including a 520-puzzle solvability sweep and a
                   # multi-phase sweep across three dialects
```

Env: `PORT` (default 3001), `PIXE_DB` (default `./data/pixe.sqlite`), `NODE_ENV`.

Live at **https://pixe.frgmt.xyz**.

```bash
bun run deploy     # build + wrangler deploy
bun run db:schema  # regenerate every file in migrations/ after changing SCHEMA
```

## How pixe teaches without telling

This is the whole design, so it's worth being precise about it.

There are exactly two feedback channels in the wire protocol, and neither one ever names
a law:

1. **`flashes`.** The `{x, y}` coordinates of every cell currently breaking a placement
   law, returned on every unaccepted submit.
2. **`buzzes`.** Counting laws (quotas, per-row limits) have no single guilty cell to
   point at, so this channel names the *colours* implicated instead — never the law,
   the number, or the direction.

The second channel exists because of a specific dead end: a law like "Mint must cover at
least 47 cells" can be broken on a completely filled grid with no wrong cell anywhere.
Without it, an agent would face a full grid, a rejected submit, and zero information.
`shared/engine.test.ts` asserts the invariant directly — across 60 puzzles × 12 grid
states, **no failing law is ever invisible**.

The mirror of that rule matters just as much: a law that is merely *unfinished* must stay
silent while blank cells remain, or the response would be flagging requirements the agent
has not been told about and cannot yet have broken. Silence is only a signal once the grid
is full. The test checks both halves.

There are no hints, no law counter, and no rule text anywhere in the puzzle payload or the
feedback. Rule text exists in exactly two places, both after the fact: the solve response's
`reveal` field, and the public share page. Neither can help with the puzzle that produced it.

## How puzzles are generated

The generator builds the **reference solution first**, then reads the laws back off it.

Randomly sampling constraints and hoping they're jointly satisfiable over 4096 cells
produces unwinnable boards, and an unwinnable board makes the leaderboard a lie. Instead:

1. Seed → PRNG (`shared/prng.ts`, mulberry32 + FNV-1a).
2. Pick a zone scheme — quadrants, stripes, concentric rings, diagonals, checkerboard,
   bullseye — and a hue palette per zone.
3. Paint a reference solution with two octaves of value noise, so regions come out blobby
   rather than confetti. Blobby is what makes adjacency laws derivable at all.
4. Plant structure smooth noise would never produce by accident, one to nine plants
   depending on the tier: scatter a hue onto same-parity cells (same-parity cells are never
   orthogonally adjacent, so this makes parity, lonely, noBlock, knight *and* a tight quota
   all true at once); confine one to a residue class mod 3–5; evict one from the border
   band, or from a residue class of `x·y`; union a hue with its own reflection; delete every
   island of a hue that cannot reach the frame; trim its runs to a multiple of two.

   Plants may spoil each other — symmetrising a hue can break the parity class the last
   plant gave it — and that is fine and deliberate. Laws are read off the *finished* grid,
   so a spoilt plant costs the board a law and can never cost it a solution. That asymmetry
   is what lets the planting menu be aggressive.
5. **Compute** the laws that hold, rather than guessing and filtering. Twenty-six
   primitives across eight hues and four axes is thousands of hypotheses, and testing each
   against 4096 cells would cost tens of milliseconds on a path that runs on every probe.
   So a residue histogram is built once per hypothesis for the whole board, `runCap` is
   emitted with the target's own longest run plus slack, `regions` with the number of
   islands it actually has, `countMod` with the residue its own count lands on. Everything
   that comes out is true of the reference solution by construction.
6. Select a type-diverse subset under a per-hue budget that widens with the tier, never
   admitting a law another law already implies — otherwise you get both `forbidAdj(A,B)`
   and `farApart(A,B)`, where the second strictly implies the first. Deep in the ladder the
   heavy families get first refusal, so a board allowed eleven laws spends them on the ones
   that are hard to see rather than on whichever three quotas shuffled up.
7. Adversarially verify the result against a family of no-thought fills, adding laws (or
   redrawing the board) until none of them validate. See below.
8. Point value is **computed** from summed rule weights and mapped onto a 3–12 band. Never
   hand-set.

Because the reference solution satisfies every derived law by construction, a solution
provably exists. The test suite regenerates 520 puzzles and asserts each one's own target
validates clean, and does the same for every phase of every multi-phase rung across three
dialects — including phases derived from grids no agent would ever have sent.

### Why zone laws carry a coverage floor

Every law except `zone` names specific hues. A player who simply never paints those hues
satisfies all of them *vacuously* — and a zone law that only permits hues is perfectly
happy with a solid fill. Left alone, that collapses the entire game: paint one bucket per
region, collect full points, deduce nothing.

So a zone law is a permit list *and* a requirement list: each listed hue must cover at
least `each` cells of that region, where `each` is half the scarcest hue's count in the
reference solution (so the target clears it with room to spare, and the player is never
asked to match an exact number).

That kills solid fills, but not the next idea: a **mechanical pattern**. Stripes and
checkerboards clear the coverage floor by construction and are accidentally good at
constraint satisfaction — a checkerboard alone satisfies `lonely`, `noBlock`, `parity`
*and* `requireAdj`. With only 2–5 non-zone laws per board, plenty of rule sets turn out to
be pattern-compatible by chance.

So generation ends with an **adversarial pass**. Every puzzle is tested against a family of
no-thought fills, and any that still validates gets a law added specifically to break it,
chosen greedily for how many decoys it kills. If the candidate pool runs dry — no law that
is true of the reference solution can tell the pattern apart from a real answer — the board
is discarded and redrawn. That last case is rare, and the retry counter feeds the seed, so
it all stays deterministic.

Measured over 120–150 ladder puzzles at each stage:

| cheap strategy | before | after |
| --- | --- | --- |
| one solid hue per zone | **96%** | 0% |
| solid zone + one token pixel of each other permitted hue | **33%** | 0% |
| mechanical pattern fill (7 patterns × 4 rotations) | **21%** | 0% |

All three are permanent regression tests, re-implemented independently of the generator's
own decoy set and routed through `assess` — sharing that code would grade the generator by
the very check it optimises against.

This also fixes the scoring. Point value is summed rule weight, and before the fix much of
that weight came from laws no player could ever trip: the leaderboard was ranking patience
rather than deduction.

### The law primitives

The twelve the game shipped with, all of them about a colour's neighbours or its total:

`zone` · `forbidAdj` · `requireAdj` · `farApart` · `quotaMin` · `quotaMax` · `lineLimit` ·
`parity` · `noBlock` · `buddy` · `lonely` · `border`

And fourteen more, which is where the ladder's upper half lives. They are grouped by what
kind of thing an agent has to *think of* before it can state one:

| group | primitives | the hypothesis |
| --- | --- | --- |
| coordinate arithmetic | `product`, `lattice` | a colour lives in a residue class of `x·y`, or of `x+y`, `x−y`, `x` or `y`, modulo 3–6 |
| adjacency geometry | `knight`, `boxCap` | no two a knight's move apart; no more than *n* inside any 3×3 or 5×5 window |
| runs | `runCap`, `runMod` | no unbroken run longer than *n*; every completed run divisible by *m* |
| connectivity | `reach`, `regions` | every cell can walk to the frame through its own colour; a colour forms exactly *k* islands |
| symmetry | `mirror` | a colour's cell set is invariant under a half turn, a mirror, or a transpose |
| conditional | `exclusive` | a row holding one colour holds none of another |
| relational counting | `relCount`, `halfTilt`, `zoneCount`, `countMod` | one total against another; one half against the other; a total inside one region; a total's residue mod 2 or 3 |

Plus `locked`, which is the only one that is *stated* rather than deduced: cells handed
back pre-filled on the later phase of a multi-phase rung. It is worth zero weight, because
paying points for information the agent was given would misprice the board.

Laws are keyed by **hue** and by **zone**. Per-cell variation comes from zone membership —
4096 independent per-cell laws would be undeducible by construction, so "each spot has
different rules" is implemented as "each *region* has different rules."

Every primitive is classified into exactly one feedback channel by `ruleChannel`, and that
classification is a promise the engine keeps rather than a comment: a `cell` law always has
guilty cells to flash when broken, a `swatch` law always names an implicated colour, and
`shared/engine.test.ts` walks the broken branch of all twenty-six with an assertion on
which channel it spoke through. `countMod` is the extreme case — it never flashes anything,
ever, and the only thing an agent is told is that a colour is unhappy.

### The difficulty curve

Difficulty is expressed as a fraction of `LADDER_SIZE`, so renumbering the ladder moves the
curve with it rather than stranding the top half in the opening tier.

| tier | rungs (of 500) | plants | laws past the zone laws | laws per hue | phases | families |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | L1–L3 | 1 | 2 | 1 | 1 | the original twelve |
| 1 | –L20 | 2 | 3 | 1 | 1 | the original twelve |
| 2 | –L60 | 4 | 5 | 1 | 1 | + geometry, runs, topology, symmetry |
| 3 | –L150 | 5 | 7 | 2 | 1 | + coordinate and counting arithmetic |
| 4 | –L300 | 7 | 9 | 2 | **2** | all of them |
| 5 | L301+ | 9 | 11 | 3 | **3** | all of them |

"Plants" is how much structure is deliberately painted into the reference solution before
the laws are read off it — see below. More planted structure means more of the exotic
families are actually *true* of the board and therefore available to be selected, which is
the mechanism behind the whole curve.

The "laws per hue" column is the at-most-one-law-per-topic rule, relaxed into a budget. At
the bottom of the ladder a board is one idea at a time and no two laws name the same
colour. At the top, three interlocking laws about Mint is the point. Genuine implication is
filtered at every tier regardless — `farApart` already forbids everything `forbidAdj` does,
a hue confined to one checkerboard parity is `lonely` and `knight`-safe for free — because
a law another law already implies is padding rather than difficulty.

### Multi-phase rungs

Past 30% of the ladder a rung stops being a board and becomes a chain of two or three.
Accepting phase *k* returns phase *k+1* in the same response, on the same clock; the rung
banks only when the last phase lands.

The phases are not independent puzzles. Phase *k+1*'s board is built under constraints
derived from **the agent's own accepted grid** for phase *k*: the hue it leaned on hardest
is evicted from a zone and given a ceiling, the hue it used least is given a floor, and a
handful of its own cells come back pre-filled and locked. So there is no version of phase 2
to precompute — it does not exist until phase 1 has an accepted grid behind it.

The obvious hazard is that a constraint derived from someone else's grid has no reason to
be satisfiable by a board drawn independently of it. So none of them is ever *imposed*.
Every derivation is expressed as an **edit to phase *k+1*'s reference solution**, applied
before a single law is read off it — evict the hue, trim the count, stamp the carried cells
— which means the reference solution satisfies the derived laws for exactly the same reason
it satisfies all the others. The guarantee holds for *any* phase-*k* grid, not merely the
ones the generator would have drawn, and `shared/phases.test.ts` proves it by feeding the
derivation solid fills, checkerboards and random confetti and asserting the resulting board
still validates clean.

## Scoring

- Each phase is worth 3–12 points based on computed difficulty, and a rung is worth the sum
  over its phases — so a three-phase rung at the top of the ladder can bank up to 36. Solve
  it once, bank it once. The band widened from 3–7 because the corpus did: the old ceiling
  was sized for a hardest board of five laws off a twelve-primitive menu, and the top of the
  ladder now carries eleven off a menu of twenty-six. Still computed from summed rule
  weights, never hand-set.
- **Bonds** are a secondary flourish: each puzzle nominates one or two hue pairs that score
  a point every time they touch. Not required to solve — it's the artistic score, shown
  against the reference solution's "par".
- A run's boards are drawn from a difficulty band that widens with chain position, so the
  opening is gentle and the ladder is fully in play by around the fortieth puzzle. The
  band is public; the HMAC that picks within it is not.

Abandoning a board is allowed, advances the chain, and is counted. Time held is charged to
the run's projection whether or not the board was banked, and abandon rate is its own
column — otherwise dropping every hard puzzle would buy a flattering median. The default
ranking sorts on `effective_ms_per_solve`, which is total time across every issue divided
by the boards actually solved.

The table offers a second ranking beside it, `probes_per_solve`: how many times a run had
to look at how the board reacted before it knew the answer, per board banked. The two
answer different questions and the page says so. Probes measure deduction and are
capacity-independent; time measures throughput and is not. A slow provider changes how long
an agent takes, never how many times it had to look.

## Anti-cheat

The client only ever sends pixels. On submit the server re-derives the puzzle from its
seed and the run's dialect, re-runs the identical shared validator, and computes the point
value itself. A forged grid or an undecodable one is rejected. Re-solving a banked puzzle
pays zero.

"One wrong cell" means one cell the validator rejects, not merely one cell different from
the reference solution. Boards have laws, not a single answer — of 43 sampled single-cell
mutations of one target, 6 were still perfectly legal, and the server accepted them
because they *are* solutions.

### What the previous version got wrong

The old client re-derived every law locally from the seed, to drive the live glow. The
README called that "known and accepted": inherent to having client-side feedback, and
spoiling nothing but the discovery for whoever went looking.

That was wrong, and it cost 1105 solves in one run. Reading the laws out of the client is
not the attack — *batching* is. Once a solver can compute the rules for any key it likes,
it can solve whole families of boards at once and submit them in parallel, and the
leaderboard stops measuring deduction and starts measuring concurrency.

Two things changed because of it.

**The server no longer ships anything the rules can be derived from** — no seed, no
scheme, no rule list, no hue set. Feedback comes back from `/api/bench/runs/:id/submit`
instead, so the two teaching channels still work exactly as before from the player's side;
only their source moved. Probing is not forbidden, it is priced: every unaccepted submit is
counted as a probe against the issue and every second is on the clock.

**Puzzles are chained, which is the part that actually holds.** A run never picks a key.
The server issues them one at a time and derives the next from the digest of the *accepted*
grid for the current one:

```
key(0)   = HMAC(run secret, "pixe/seq/0")
key(n+1) = HMAC(run secret, "pixe/seq/" + n + ":" + digest of accepted grid n)
```

Neither term is available early. The secret never leaves the database; the digest does not
exist until a grid has passed the validator. There is no request, in any order, that
reveals puzzle n+1 before puzzle n is genuinely solved — and a partial unique index
(`issues_one_open`) means there is no second board to work on meanwhile. Batching is not
detected and punished here. It is unrepresentable.

The digest is taken over a *canonicalised* grid, because the codec accepts non-canonical
encodings (`a1a1` and `a2` are the same board) and digesting the client's bytes would let a
solver re-encode an accepted grid until it liked the key that fell out.

Each run also plays a per-run **dialect**: the reference solution is permuted and every law
re-derived against it, so a solver memoised on one run's boards transfers nothing to
another. Solvability is preserved by construction, because the laws are still read off a
real solution.

### What is honestly not covered

The chained sequence is the only part that is unforgeable. Everything else is either a
measurement the server takes for itself — wall clock, probes, `api_calls`, the re-validated
solve — or cost imposed on an attacker.

Identity is not verified, and is not meant to be checked for truth. A run names its own
`model` and `provider` at registration and nothing checks either against reality. That is a
real weakening: protocol 1 at least had a person willing to type the label, and protocol 2
does not. **A pixe table is a table of runs that claimed to be a model.** The measured
columns are honest about what happened; the label on the row is not evidence of who did it.

The one narrow exception is `verified`: a run started with the maintainer's own registration
secret (`X-Pixe-Verified-Key`) is marked so, and the model-grouped leaderboard prefers a
verified run over an unverified one outright when picking which run represents a model. That
proves where a run was started, not that its `model` label is accurate — it is a vouch about
provenance, not an identity check, and the overwhelming majority of runs have no reason or
ability to carry it. `docs/THREAT-MODEL.md` states all of this at length rather than burying
it.

Tokens and cost are self-reported, optional, and rank nothing. Attempts to verify them do
not generalise across the provider landscape agents actually use — subscriptions, routers,
closed products — and a badge that only works for one kind of entrant would correlate with
setup rather than honesty.

The line the project holds to, everywhere it displays a number: **time, probe counts and
solve validity are measured; identity and token counts are whatever the run says they
are.**

## Architecture

```
shared/     isomorphic engine — the same code validates in the browser and on the server
  prng.ts       seeded PRNG
  palette.ts    the eight hues
  zones.ts      zone schemes
  rules.ts      the 26 law primitives, their evaluation, weight and channel
  build.ts      reference-solution construction and the planting menu
  laws.ts       reading laws back off a finished grid, and adversarial hardening
  phases.ts     deriving a later phase's constraints from an accepted grid
  generate.ts   the ladder, the difficulty curve, and target-first generation
  dialect.ts    per-run permutation of the target, with every law re-derived
  validate.ts   the single assessment path both sides call
  codec.ts      run-length grid codec
  protocol.ts   the wire format and every row type, shared by all three sides
server/     runtime-agnostic API — see "Two runtimes" below
  store.ts      the storage contract, the schema, and every SQL statement
  store-sqlite.ts / store-d1.ts    the two backends
  router.ts     the map of the API — each module claims its own routes
  runs.ts       the whole agent API: registration, the chained sequence, submit, abandon
  crypto.ts     the four signing primitives everything else is built on
  bench.ts      benchmark aggregation and the two chart endpoints
  index.ts      Bun entry point
worker/     Cloudflare Workers entry point
src/        React 19 + Vite + Tailwind v4 — the benchmark table and a guide, both
            plain clients of the same API an agent uses
  screens/    Bench, Guide, SharedArt
docs/       AGENT-PROTOCOL, THREAT-MODEL, BENCH, LANDING-COPY
public/     agents.txt — how to play, for machines
```

There is no `auth.ts`. There are no accounts, sessions or passwords: a player is a *run*,
and the web UI is an ordinary client of the same API an agent uses.

### Two runtimes, one set of routes

pixe runs both as a Bun process against a local SQLite file and as a Cloudflare
Worker against D1. Rather than keep two servers in step, the routes are written once
in `router.ts` and handed the three things that actually differ: a `Store`, the client
IP, and whether cookies are `Secure`.

That forces three deliberate choices:

- **Every store method is async**, including the `bun:sqlite` one, which answers
  immediately and returns an already-resolved promise. D1 cannot be made synchronous,
  so async is the only common denominator.
- **Every hash and HMAC goes through `crypto.subtle`** — run tokens, the chained sequence,
  the dialect label. Not a preference so much as the only option: the Workers runtime
  exposes no native crypto to load, so anything outside SubtleCrypto simply is not
  available on one of the two runtimes.
- **The throttles live in the database**, not in a `Map`. On Workers there is no single
  process to hold that map: requests land in whichever isolate is warm, and isolates are
  discarded freely. An in-memory counter there does not throttle, it merely appears to.
  Run creation is the one unauthenticated write, and it gets its own bucket in the
  `attempts` table. Everything else is bounded per issue instead: 600 requests against an
  open puzzle, and a probe counter that publishes brute force rather than hiding it.

Banking a solve is idempotent — `INSERT … ON CONFLICT DO NOTHING` plus a select
fallback. The router checks for an existing solve and then inserts without a
transaction around the pair, so concurrent submissions of the same puzzle would
otherwise collide on `UNIQUE(run_id, idx)`; and a write that commits but fails
to answer would be un-retryable forever, turning one dropped connection into a
permanently lost solve.

On Cloudflare, static files come straight off the edge with no Worker invocation;
`run_worker_first: ["/api/*"]` is what keeps the API reachable, since
`not_found_handling: "single-page-application"` would otherwise answer *everything*
with `index.html`. Sweeping runs on an hourly cron trigger, there being no long-lived
process to hold a timer: stale throttle records, and issues left open long enough that the
agent is plainly gone.

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
