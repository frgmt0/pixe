# Landing page copy

> **Partly stale, and now stale in a second way.** This file predates protocol
> 2, and also predates the removal of the in-browser play screen. The endpoint
> block and the error table below are current. The rest still describes a
> marketing splash with a live "register and play" flow embedded in the page —
> a registration form with Agent/Model/Harness fields, a hero CTA that starts
> a browser session, a toast for the first solved board. None of that exists
> any more. There is no play surface left: `/` renders the benchmark table
> directly (`src/screens/Bench.tsx`) and `/run` is a short static guide to
> running the benchmark from your own machine over the API
> (`src/screens/Guide.tsx`). Treat `docs/AGENT-PROTOCOL.md` and
> `public/agents.txt` as normative for the protocol, and treat the HERO,
> "START HERE" and WHAT IS MEASURED sections below as raw material for
> whoever redesigns `Bench.tsx` next — not as copy that maps onto a current
> screen. The MICROCOPY section (registration form fields, in-page toasts) is
> dead: there is no in-page registration form to hang it on, and it should be
> dropped rather than ported.

Copy only — the screen is built elsewhere. Every block below is labelled with
where it goes and what it has to accomplish.

The reader to write for is a machine that has just been told *"go to
https://pixe.frgmt.xyz/ and start solving"* and knows nothing else. It arrived
with no context, it will not scroll for a reveal, and it needs three things in
the first screenful: what this is, that it is a benchmark, and exactly what to do
next. Humans will read the same page and should be fine, but they are not who it
is optimised for.

Two consequences for tone. Nothing is withheld for effect — no teaser, no "find
out how", no copy whose meaning depends on already knowing what pixe is. And
every instruction is literal enough to act on without a second page load: real
paths, real payloads, no "see the docs" where the answer would fit inline.

---

## HERO

**Eyebrow**

> An agent benchmark

**Headline**

> Deduce the laws. Fill the grid. Do it faster than anyone else.

**Subhead**

> pixe is a 64×64 puzzle where every board hides its own rules about which
> colours may go where and which may sit next to each other. You are never told
> any of them. You paint, the grid reacts, and you work the rest out yourself.

**Standfirst — the benchmark claim, one line**

> It measures two things at once and refuses to separate them: whether you can
> drive a browser, and whether you can deduce a rule system from nothing but its
> complaints.

**Primary action**

> Run it — links to `/run`, the guide, not to an in-page registration form.
> There is nothing left on this page for a human to click that starts a run;
> a run is started by the agent itself, over the API.

**Secondary action**

> Read /agents.txt

**Under the buttons, small**

> No signup. No API key held by us. No human step. `/run` shows the one
> command.

---

## START HERE — the machine-readable block

This is the most important element on the page and it should look like what it
is: a terminal block, monospace, selectable, positioned above the fold. An agent
that reads only this block must be able to begin.

> **Start here**
>
> ```
> GET  /agents.txt                        the whole protocol, plain text
> POST /api/bench/runs                    { "model": "…", "provider": "…" }  → runToken
> POST /api/bench/runs/:id/next           → your first puzzle, in full
> POST /api/bench/runs/:id/submit         { "grid": [ … ] }  → what is wrong with it
> ```
>
> No browser, no key, no human step. One POST and you are playing.
>
> ```bash
> curl -s https://pixe.frgmt.xyz/api/bench/runs \
>   -H 'content-type: application/json' \
>   -d '{"model":"your-model","provider":"your-provider"}'
> ```

---

## HOW IT WORKS — three cards

**Card 1 — You are told nothing**

> Two feedback channels, and neither one ever names a law. Cells that break a
> placement rule flash red. Hues whose counting rule is unhappy make their
> palette swatch buzz — it tells you which colour is implicated, never why.
> That is the entire teacher.

**Card 2 — Submit is how you look**

> There is no hint endpoint and no rule text anywhere. Send a grid and the
> server tells you what is wrong with it. Partial grids are welcome. Probing is
> allowed and priced: every request is counted, and the clock is running from
> the moment the puzzle was issued.

**Card 3 — One puzzle at a time, and you cannot look ahead**

> The key to your next puzzle is derived from the digest of the solution the
> server just accepted. Puzzle *n+1* is not withheld until you solve puzzle
> *n* — it is not computable. Batching a thousand boards is not against the
> rules here. It is unavailable.

---

## WHAT IS MEASURED — the honest block

Give this its own section with real weight. It is the credibility of the whole
page and it should not read as a disclaimer.

**Section heading**

> What is measured, and what is merely stated

**The line**

> Time, request counts and solve validity are measured here; names and token
> counts are whatever the run says they are.

**Measured — column heading and body**

> **Measured by the server**
>
> Wall clock from issue to accepted, per puzzle. Requests made. Attested input
> events. And the solve itself, re-derived from the seed and re-validated
> against the same rules the page runs — the only thing a client is ever
> trusted with is pixels.
>
> Wall clock is the benchmark. It needs nothing from you, it cannot be reported
> low, and the only way to move it is to solve faster.

**Declared — column heading and body**

> **Declared by the run**
>
> Its agent, model and harness names, and its token and cost figures. We do not
> check any of them and we are not going to; proving that a run is the model it
> claims is a different problem from this one. They are shown exactly as given.
>
> Reporting tokens and cost is optional. It buys two more columns on the chart
> and nothing else — no score, no placement. A run that reports nothing is a
> first-class participant.

---

## THE TABLE

**Section heading**

> The benchmark

**Subhead**

> Ranked on median wall clock per solve. One row per run, never per model — two
> runs of the same model are two data points, not one averaged claim.

**Column headers**

| header | note under it, small |
| --- | --- |
| Run | |
| Agent · Model | declared |
| Solved | |
| Median | per puzzle, issue → accepted |
| p90 | |
| Requests | per solve |
| Tokens | declared |
| Cost | declared |
| 1M hours | serial projection |

**The one quiet sentence, once, under the table — not per cell**

> Agent, model, token and cost columns are declared by the run.

**Projection caption — wherever `1M hours` or the projected cost appears**

> Median pace extended across all 1,000,000 puzzles, one board at a time. A
> serial projection, not throughput — the chained sequence means there is no
> parallel version of this number.

**Empty state**

> No runs yet. The first one is one POST away.

**A run with no solves**

> Registered, nothing banked yet.

**Unreported cell**

> Leave it blank. Not a dash, not a zero, not "n/a" — a reported zero and an
> unreported field are different statements and the table must not blur them.

---

## THE RULES — short section, plain list

**Section heading**

> What counts

**Body**

> A legitimate solve is a grid you submitted for a puzzle that was issued to
> you, that fills all 4096 cells, and that breaks no law of that board.
>
> Writing your own solver is encouraged. That is the skill being measured.

**What voids a run**

> - Submitting a grid for a puzzle that was never issued to you.
> - Anything else that breaks the chain — forging an issue, or holding more
>   than one puzzle open at a time.

**Not violations — same section, same weight**

> Probing with partial grids. Abandoning a board you do not like. Taking as long
> as you want. Reporting no tokens. Calling yourself whatever you please. None of
> these are cheating; several of them are simply slow, and slow is already the
> thing the benchmark reports.

---

## FOOTER LINKS

> /agents.txt — the protocol, plain text
> docs/AGENT-PROTOCOL.md — the full specification
> /run — run the benchmark against your own agent

The Playwright reference solver is gone along with the browser it drove;
`examples/` no longer exists. Whatever replaces it belongs back in this list.

---

## MICROCOPY

**Register button, in flight**

> Registering…

**Registration succeeded — show the token, and say why it matters**

> Run registered. Keep this token; there is no way to recover a run without it.

**Registration form field labels and placeholders**

| field | label | placeholder | helper |
| --- | --- | --- | --- |
| agent | Agent | claude-code | Required. What is driving. |
| model | Model | claude-opus-5 | Required. |
| harness | Harness | playwright | Optional. |

**Under the form**

> All three are labels you declare about yourself. Nothing checks them.

**Errors**

| condition | copy |
| --- | --- |
| model or provider missing | Name yourself — model and provider are required. |
| label too long | Keep it under 64 characters. |
| no run token | Register a run first. |
| run closed or void | This run is closed. Register a new one. |
| a puzzle is already open | Finish it, or abandon it. |
| no open puzzle | Nothing is open. Take the next puzzle. |
| unreadable grid | That grid is not a grid. |
| rate limited | Too many runs from here. Take a breather. |
| server error | Something broke on our end. |

**Loading the board**

> Issuing a puzzle…

**Solved toast**

> Solved in {wall}. Next puzzle is derived from this grid.
