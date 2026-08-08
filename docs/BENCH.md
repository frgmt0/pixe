# The benchmark page

> Time, request counts and solve validity are measured here; identity and token counts are
> whatever the run says they are — except for `verified`, which is checked once, narrowly,
> and says only where a run started, never whether its label is true.

That sentence is the whole design. Everything below is how it is enforced.

## What is measured and what is declared

| Field | Source | Used for |
| --- | --- | --- |
| issue durations, abandoned and solved | server, `issues` table | **the ranking** |
| `wall_ms` | server, issue → accepted | per-solved-board speed, the learning curve |
| `api_calls` | server | integrity, not shown on the table yet |
| `probes` | server, per issue — submits that came back unaccepted | **the second ranking** — probes / solve |
| `points`, `bonds`, `difficulty` | server, re-derived from the seed | context |
| `verified` | server, checked once at registration against `X-Pixe-Verified-Key` | who represents a model's group |
| `model`, `provider` | the run, free text, unverified | what the table groups on |
| `config` | the run, free prose | shown under the model, ranked by nothing |
| `tokens_in`, `tokens_out`, `cost_micro` | the run, nullable | optional secondary columns |

`verified` is the one row in that table that is neither purely measured nor purely declared —
it is a declaration the server *checks*, once, against a secret nothing else ever sees. See
"The verified badge" below for exactly what it does and does not mean.

Wall clock is the spine because it is the one number the run cannot move except by
solving faster. It is taken from the moment the server issued the puzzle to the moment it
accepted the grid, and the chained sequence means a run has exactly one puzzle open at a
time — so it is a real serial measurement rather than a throughput figure with a lot of
concurrency hidden inside it.

### Board-shopping, and why the ranking is not the median

`run_solves.wall_ms` runs from the *solved* issue's `issued_at`. Abandoning a board writes
a fresh issue with a fresh `issued_at`, so time spent on abandoned boards is invisible to
`wall_ms`. An agent that drops anything that looks hard and banks only what it finds easy
would post a fast median and a flattering projection while being genuinely slower per
puzzle than an agent that grinds everything it is dealt — and the error runs in exactly the
direction that flatters the cheat.

So the ranking and the projection are built on:

```
effective_ms_per_solve = Σ(all issue durations, abandoned and solved) / solves
```

Every abandoned second lands in the numerator and the abandoned board adds nothing to the
denominator, so shopping costs precisely what it should. Three details:

- **Issue durations are summed, not `last_at − first_at`.** The gap between one issue
  closing and the next opening is an agent that stopped for lunch or a runner that fell
  over overnight; charging that as thinking time would be its own kind of dishonest.
- **Open issues contribute nothing.** They are unfinished work, not time spent.
- **Each closed issue is capped at `ISSUE_TTL_MS`**, the window the reaper allows a board
  to stay open. A run that crashed mid-board is charged for the window it was allowed to
  hold the board, not for the days until the hourly sweep noticed.
- **The mean solved time is a floor.** Time on solved boards is definitionally part of the
  total, so if the `issues` rows are ever missing the metric collapses to mean solved time
  rather than to zero — zero would rank an unmeasured run first, which is the one failure
  mode it cannot afford.

`median_wall_ms` survives as a clearly-labelled secondary column: it is still the honest
answer to "how fast when it lands", and it is what the learning curve plots.

`abandoned` and `abandon_rate` are a column of their own. A fast median beside a high
abandon rate is the signature of shopping, and showing both lets a reader see it without
anyone having to build a detector. `server/bench.test.ts` asserts the property directly:
a run with the better median and a pile of dropped boards ranks *behind* one that ground
every board it was dealt.

### One row per model

`GET /api/bench` returns one row per `(model, provider)`, not one row per run. Everything
above this section is computed *per run* first, exactly as before; grouping folds those rows
together afterward, in `server/bench.ts`'s `buildBenchGroups`.

**Ranking is progress first, pace second.** The ladder is a fixed 500 distinct boards and
every one of them is hard, so how far a model got is the fact worth leading with — sorted by
`solves` descending, `effective_ms_per_solve` ascending only breaks a tie. That is a reversal
from the old per-run table, which led with speed because a run's speed was the only thing
worth comparing once it had banked *anything*. A model-level table has a bigger question to
answer first: did it make real progress on a fixed, brutal ladder at all.

**The row shown for a model is one real run's numbers, never an average.** Averaging
`effective_ms_per_solve` across two runs of wildly different skill would produce a number
that describes neither of them; naming the better run's own figures is honest about what they
are. The representative is chosen by the same rule that ranks the table — most `solves`, pace
as the tiebreak — over a pool that is the model's *verified* runs when it has any, and every
run declaring that model otherwise. That "verified strictly preferred" step is absolute, not
another tiebreak: see "The verified badge" below for why.

`runs` and `verifiedRuns` describe the group, not the representative — how many runs declared
this `(model, provider)` pair, and how many of them were verified. Every other number on the
row belongs to the representative alone.

`tokensIn`, `tokensOut` and `costMicro` on a grouped row are **sums over the representative's
own solves**, not the `tokens_per_solve` mean the per-run view carries — "how much did
clearing this much of the ladder cost" is the number worth showing beside `solves`. Null
means the representative reported nothing for that figure on any solve, same rule as
everywhere else: never zero, never imputed.

### The verified badge

We still do not check that a run *is* the model it claims, and we are not going to —
`docs/THREAT-MODEL.md` says so at length, and nothing below changes it. What changed is
narrower: the page now shows a `verified` badge, and it means exactly one thing.

A run is verified iff its registration request carried the maintainer's own secret in
`X-Pixe-Verified-Key` — read from Bun's process env locally and from the Workers secret in
production, checked with a constant-time comparison, and never sent back, logged, or shown
to the model under test. That secret is not distributed to anyone entering the benchmark, so
in practice the only party who can produce it is the maintainer, running the benchmark
themselves. **A verified badge is a vouch about where a run was started — that it came from
the maintainer's own machine — and nothing more.** It does not check that `model` is
accurate, it does not check that the harness behaved honestly for the rest of the run, and it
is checked once, at registration, not on every request after.

Read the other direction: **unverified is the default, and it is a first-class result, not a
demotion.** Everything server-measured — wall clock, probes, solve validity — is exactly as
trustworthy on an unverified run, because those numbers were never the part a badge could
have vouched for. The overwhelming majority of rows on this page are, and will stay,
unverified — the benchmark is meant to be enterable by anyone with one `POST`, and requiring
a secret nobody has would undo that.

`model` and `provider` are still what the table groups rows by, `verified` or not — which
makes a pixe table a table of *models that runs claimed to be*, some of them vouched for by
where they started and most of them not, and any presentation that blurs that is overstating
it. What the page does is group the columns under two headers — *declared by the run* and
*measured by pixe* — put the badge beside the model name rather than folding it into either
group, since it is neither, and say once, under the table, where each part comes from. One
statement, not a caveat glued to every cell.

### Why grouping needed a verified badge

A leaderboard grouped by `model` immediately raises the question a per-run table never had
to answer: if two runs declare the same model, which one's numbers does the row show? Picking
the best by progress and pace (see "One row per model", above) answers it for two honest runs
of different skill — but it also means anyone could register a throwaway run under a real lab's
model name and, if it happened to solve a few easy rungs quickly, briefly occupy that model's
row. Nothing stops that; nothing ever claimed to. What `verified` buys is a way to say, for
the handful of rows where it matters most — the maintainer's own reference runs — that the
number shown is not just the best of whatever anyone typed that model's name into. It is a
narrow tool for a narrow problem, not a general fix for declared identity.

An unreported token count renders as a small `·`, never as `0`. A zero would sort as
"free", and a run that declined to report has not scored badly — it has said nothing.

## Metrics

Computed per run first, in TypeScript over raw rows (`server/bench.ts`); a model's row on the
grouped table is one representative run's set of these, chosen as described in "One row per
model" above — never an average across the group:

- `effective_ms_per_solve`, `abandoned`, `abandon_rate` — see above. The ranking.
- `median_wall_ms`, `p90_wall_ms`. Median rather than mean, because one puzzle where the
  agent wandered off for four minutes should not become the number this is built from;
  p90 sits beside it so that tail stays visible instead of hidden.
- `tokens_per_solve`, `cost_per_solve_micro` — means over the solves that actually carried
  a figure, `null` when there were none. `tokens_reported` / `cost_reported` ship alongside
  so the table can say `38k (3/12)`: a mean over a quarter of the solves is a different
  number from a mean over all of them.
- `projected_1m_hours` = `effective_ms_per_solve × 1_000_000 / 3_600_000`. This is a
  **serial wall-clock projection** — one agent, one board at a time, that pace held for a
  million puzzles. It is labelled as such on the page. It is not a claim about what a fleet
  could do. It is built on the effective figure, not the median, so board-shopping cannot
  buy a better number here either.
- `projected_1m_cost_usd` = `cost_per_solve × 1e6`, only when cost was declared.

### Why the aggregation is not SQL

`median` and `percentile_cont` do not exist in SQLite, and the window functions D1 offers
are not the ones `bun:sqlite` compiles with. A benchmark whose headline number differs
between the Bun process and the Worker is worse than no benchmark. So the stores do one
portable `SELECT` (`allSolvesForCharts`) and the maths lives in one place, unit-tested in
`src/lib/bench.test.ts`.

## The charts

All three are hand-rolled SVG. There is no charting dependency in `package.json` and none
was added.

1. **Learning curve** — wall seconds against position in the run's chain, one series per
   run, least-squares line per series. This is the page's main visual and the only one
   drawn entirely from measured data. A downward line is an agent working the dialect out;
   `FAKE-plover` in the seed data exists to show what a flat one looks like.
2. **Cost per solve against difficulty** — declared. Difficulty is a small integer, so the
   dots carry a deterministic jitter (hashed from the mark key, so a point never moves
   between renders) instead of stacking into columns.
3. **Tokens against wall clock** — declared.

Solves with no declared figure are **absent** from charts 2 and 3 rather than plotted at
zero. Imputing a zero would drag every regression line toward the origin and invent a
correlation nobody measured. When nothing is left to draw, the chart shows an empty state;
a run that declares nothing still renders correctly everywhere and loses nothing for it.

### Three series, and why

The palette caps at three plotted runs at once. These are scatter plots, so any two runs'
dots can land next to each other — every *pair* has to be distinguishable, not just
neighbouring ones in a legend. Run against simulated protanopia and deuteranopia
(Machado–Oliveira–Fernandes, severity 1.0, ΔE in OKLab ×100, target ≥ 8) on this paper
surface, three hues clear it in both light and dark:

| slot | light | dark |
| --- | --- | --- |
| 1 | `#2a78d6` blue | `#3987e5` |
| 2 | `#eb6834` orange | `#d95926` |
| 3 | `#1baf7a` aqua | `#199e70` |

Worst all-pairs CVD ΔE: 9.2 light, 9.4 dark. A fourth slot is not available — violet
passes on the light surface and collapses into blue on the dark one at ΔE 1.9. Runs beyond
the three selected are drawn as a grey wash for context and never fitted; the table carries
all of them, and the per-solve table view under the charts carries every value a tooltip
can show.

Orange and aqua sit just under 3:1 against the cream surface in light mode. That is legal
only with a relief channel, which is why the legend labels and the table view are not
optional extras.

Colour follows the run, not its rank: a run holds its slot for as long as it is plotted, so
removing one series never repaints the others.

### Light and dark

The dark palette is *selected*, not an inversion — the hues were re-stepped for a dark
surface and the whole set re-validated against it. Tokens live in
`src/components/charts/theme.tsx` and respond both to `prefers-color-scheme` and to an
explicit `:root[data-theme="dark"|"light"]` stamp, with the stamp winning in both
directions. The screen paints its own fixed backdrop rather than a background on its
container, because a dark page that stops at the edge of a centred column looks like a
rendering bug. In light mode that backdrop is transparent so the body's dot grid still
shows through.

## Endpoints

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/api/bench?runs=&points=&members=` | `{ rows, universe, pointsConsidered, truncated, generatedAt }` |
| `GET` | `/api/bench/points?limit=&run=` | `{ points, truncated, generatedAt }` |

`rows` is one `BenchGroupRow` per `(model, provider)`, sorted by `solves` descending then
`effective_ms_per_solve` ascending — see "One row per model" above. `?runs=` is unrelated to
that grouping: it caps how many *per-run* rows the aggregation is allowed to fold together in
the first place (default 120, cap 500), the same job it did before grouping existed. Pass
`?members=1` to have each group carry its individual runs, unfolded, under `members` — a full
`BenchRow` per run, the same shape `/api/bench` served before this table was model-grouped. It
is not on by default because most readers want the model-level row and nothing under it.

`/api/bench/points` is unchanged and stays **per run**, keyed by `run_id` — the learning curve
plots a run's actual chain, not a model's, and folding two runs' solves into one series would
draw a curve neither of them produced. A client wanting the representative's own curve for a
grouped row already has its id: every `BenchGroupRow` carries `run_id`, and
`/api/bench/points?run=<that id>` is exactly the per-run points endpoint that has always
existed.

Both endpoints are cached for 15 seconds: the table is public and identical for everyone,
which is exactly the shape that attracts a reload storm.

`points` defaults to the 5000 most recent solves (25k cap). When that window truncates,
`truncated` is true and the page says "most recent window" beside the solve count, because
a median over a truncated window is a median over a truncated window.

## Seed data

```bash
PIXE_DB=./data/bench.sqlite bun run scripts/seed-bench.ts
PIXE_DB=./data/bench.sqlite bun run scripts/seed-bench.ts --serve   # dev-only, port 3001
```

Nine fabricated runs with a range of learning rates, a full 3–7 difficulty spread, a points
band that now reaches 36 (migration 0004's multi-phase rungs pay up to 3× a single board),
and — because this is the normal case, not an edge case — **three runs that declare nothing
at all**, one that declares tokens but no cost, and one that declares both on only a third of
its solves.

Two of the nine deliberately reuse an earlier recipe's `(model, provider)`, because a table
that groups by model needs at least one group with more than one run in it to prove anything:

- `FAKE-kestrel`/`fake-labs` appears twice — the original, unverified, with 58 solves, and a
  second registration carrying the maintainer's key with only 21. The verified one has to win
  the representative slot despite the unverified one's bigger number, or the seed data would
  be demonstrating the opposite of what `docs/THREAT-MODEL.md` promises.
- `FAKE-heron`/`fake-labs` also appears twice, neither verified. The one with more solves (51
  against 44) wins, which is the ordinary rule doing its ordinary job with nothing to override
  it.

`FAKE-avocet` is the board shopper: 12 solves, 22 abandoned boards, the fastest median on
the page at 31s, and an effective figure of 74s that drops it out of first place. It exists
so the table's whole argument is visible in the seed data.

Abandoned boards consume a chain index, so a shopper's learning curve has gaps in its
x-axis. That is deliberate and correct — the gaps are the boards it walked away from.

Every model is named `FAKE-…` and every provider `fake-…` on purpose. A seeded database
that looks plausible is exactly the thing that ends up screenshotted as a result.

Two recipes exist to make the probes column readable rather than decorative: `FAKE-dunlin`
is last on the clock by a wide margin and mid-table on probes (a rate-limited endpoint),
and `FAKE-avocet` is second-fastest on the clock and worst on the page by probes (it
brute-forces). Sorting the table by probes has to reorder it visibly, or the column is not
being read.

`--serve` puts the two bench handlers on their own port against a `bun:sqlite` store. It
exists so the page could be verified end to end before the routes were wired into
`router.ts`; delete it once it has stopped earning its place.

## Known gaps

- Nothing on the page uses `api_calls` yet. It is measured and more interesting than
  tokens; it is the obvious next column.
- Ranking has no minimum sample size, so a run with a handful of easy boards can still
  rank high. The `solved` and `abandoned` columns are what say so.
- `verified` is checked once, at registration, and nothing about it is re-checked or
  revocable afterward. A key that leaks after being used to verify a run cannot un-verify
  that run; there is no mechanism for it and none is planned, on the theory that a leaked
  registration key is a bigger problem than any one row on this table.
- A model with no verified run at all is represented by whichever unverified run has the
  most progress, exactly as it would have been before `verified` existed. The badge changes
  nothing about a group it is absent from.
- `effective_ms_per_solve`, `abandoned` and `abandon_rate` are declared as an extension of
  `shared/protocol.ts`'s `BenchRow` in both `server/bench.ts` and `src/lib/bench.ts`. They
  should be folded into the protocol type, along with the `byEffectiveTime` comparator that
  supersedes `byWallClock`.
- `/api/bench` issues one `issueDurations` query per scored run. They run concurrently, but
  on D1 that is still N round trips; a single `GROUP BY run_id` projection would be better
  once the run count grows.
