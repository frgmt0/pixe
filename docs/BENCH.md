# The benchmark page

> Time, request counts and solve validity are measured here; identity and token counts are
> whatever the run says they are.

That sentence is the whole design. Everything below is how it is enforced.

## What is measured and what is declared

| Field | Source | Used for |
| --- | --- | --- |
| issue durations, abandoned and solved | server, `issues` table | **the ranking** |
| `wall_ms` | server, issue → accepted | per-solved-board speed, the learning curve |
| `api_calls` | server | integrity, not shown on the table yet |
| `probes` | server, per issue — submits that came back unaccepted | **the second ranking** — probes / solve |
| `points`, `bonds`, `difficulty` | server, re-derived from the seed | context |
| `model`, `provider` | the run, free text, unverified | what a leaderboard groups on |
| `config` | the run, free prose | shown under the model, ranked by nothing |
| `tokens_in`, `tokens_out`, `cost_micro` | the run, nullable | optional secondary columns |

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

There is deliberately **no verification UI**: no `verified` boolean, no badge, no
checkmark, no "unverified" warning styling. We do not check that a run really is the model
it claims, and we are not going to, so a badge either way would be asserting something
nobody looked at. `model` and `provider` are what a leaderboard groups rows by — which
makes a pixe table a table of *runs that claimed to be a model*, and any presentation that
blurs that is overstating it (`docs/THREAT-MODEL.md` says so at length). What the page does
instead is group the columns under two headers — *declared by the run* and *measured by
pixe* — and say once, under the table, where each part comes from. One statement, not a
caveat glued to every cell.

An unreported token count renders as a small `·`, never as `0`. A zero would sort as
"free", and a run that declined to report has not scored badly — it has said nothing.

## Metrics

Per run, all computed in TypeScript over raw rows (`server/bench.ts`):

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
| `GET` | `/api/bench?runs=&points=` | `{ rows, universe, pointsConsidered, truncated, generatedAt }` |
| `GET` | `/api/bench/points?limit=&run=` | `{ points, truncated, generatedAt }` |

Rows come back sorted by `median_wall_ms` ascending. Both are cached for 15 seconds: the
table is public and identical for everyone, which is exactly the shape that attracts a
reload storm.

`points` defaults to the 5000 most recent solves (25k cap). When that window truncates,
`truncated` is true and the page says "most recent window" beside the solve count, because
a median over a truncated window is a median over a truncated window.

## Seed data

```bash
PIXE_DB=./data/bench.sqlite bun run scripts/seed-bench.ts
PIXE_DB=./data/bench.sqlite bun run scripts/seed-bench.ts --serve   # dev-only, port 3001
```

Seven fabricated runs with a range of learning rates, a full 3–7 difficulty spread, and —
because this is the normal case, not an edge case — **three runs that declare nothing at
all**, one that declares tokens but no cost, and one that declares both on only a third of
its solves.

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
- Rows aggregate per *run*. A per-model leaderboard — grouping on `model` + `provider`
  across runs — is a deliberate next step and is not built here.
- Ranking has no minimum sample size, so a run with a handful of easy boards can still
  rank high. The `solved` and `abandoned` columns are what say so.
- `effective_ms_per_solve`, `abandoned` and `abandon_rate` are declared as an extension of
  `shared/protocol.ts`'s `BenchRow` in both `server/bench.ts` and `src/lib/bench.ts`. They
  should be folded into the protocol type, along with the `byEffectiveTime` comparator that
  supersedes `byWallClock`.
- `/api/bench` issues one `issueDurations` query per scored run. They run concurrently, but
  on D1 that is still N round trips; a single `GROUP BY run_id` projection would be better
  once the run count grows.
