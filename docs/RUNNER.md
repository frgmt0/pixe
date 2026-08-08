# run-pixe.sh — the official benchmark runner

`run-pixe.sh` runs the pixe benchmark against any model, on any provider, using
the [pi coding agent](https://pi.dev) as the harness.

It does the deterministic half of a run and none of the interesting half. It
checks your tooling, registers the run, hands an agent its credentials and the
rules of engagement, and prints the resume incantation when it is over. It never
parses a puzzle, never builds a grid, and never looks at feedback — all of that
belongs to the model under test, because a runner that helped would be measuring
itself.

Results reach the leaderboard by construction: every submit is a request to the
live server, so there is no upload step and nothing to publish afterwards.

```bash
ANTHROPIC_API_KEY=sk-ant-... ./run-pixe.sh \
  --provider anthropic \
  --model claude-opus-4-5
```

---

## Table of contents

- [Install](#install)
- [Quick start](#quick-start)
- [Provider matrix](#provider-matrix)
- [Custom endpoints: --base-url](#custom-endpoints---base-url)
- [Every flag](#every-flag)
- [What the agent is told](#what-the-agent-is-told)
- [Resuming a crashed run](#resuming-a-crashed-run)
- [Verified and unverified runs](#verified-and-unverified-runs)
- [What the runner deliberately does not do](#what-the-runner-deliberately-does-not-do)
- [Metering](#metering)
- [Troubleshooting](#troubleshooting)

---

## Install

You need `bash`, `curl`, `jq`, and pi. The runner checks all four before it
spends a token.

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

Other ways in:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pnpm add -g --ignore-scripts @earendil-works/pi-coding-agent
bun add -g --ignore-scripts @earendil-works/pi-coding-agent
powershell -c "irm https://pi.dev/install.ps1 | iex"        # Windows
```

Verify: `pi --version`. This document was written against **pi 0.84.1**.

---

## Quick start

Pick a provider, give it a key, name a model:

```bash
# Anthropic
ANTHROPIC_API_KEY=sk-ant-...  ./run-pixe.sh --provider anthropic  --model claude-opus-4-5

# OpenAI
OPENAI_API_KEY=sk-...         ./run-pixe.sh --provider openai     --model gpt-5.2

# OpenRouter
OPENROUTER_API_KEY=sk-or-...  ./run-pixe.sh --provider openrouter --model anthropic/claude-sonnet-4.6

# DeepSeek
DEEPSEEK_API_KEY=sk-...       ./run-pixe.sh --provider deepseek   --model deepseek-chat

# Moonshot (note the provider id: moonshotai, not moonshot)
MOONSHOT_API_KEY=sk-...       ./run-pixe.sh --provider moonshotai --model kimi-k2

# MiniMax
MINIMAX_API_KEY=...           ./run-pixe.sh --provider minimax    --model MiniMax-M2

# Google
GEMINI_API_KEY=...            ./run-pixe.sh --provider google     --model gemini-3-pro

# Ollama, on your own machine, no key at all
./run-pixe.sh --provider ollama --model qwen3:32b --base-url http://localhost:11434/v1
```

You can also skip the environment variable entirely for any provider you have
logged into interactively:

```bash
pi                 # then /login anthropic, /login openrouter, /login openai-codex, ...
./run-pixe.sh --provider anthropic --model claude-opus-4-5
```

Preflight asks pi itself (`pi auth check`) rather than looking for a variable,
so a subscription or OAuth login counts as credentials and passes.

Watch it go. Stop it with Ctrl-C whenever you like — the summary and the resume
line print on every exit path.

---

## Provider matrix

These are the providers pi ships a model catalog for, with the environment
variable each reads. Any of them can also be authenticated with `/login`
instead, in which case no variable is needed.

The **provider id is what you pass to `--provider`, and it is also what appears
on the leaderboard**, so it should name whoever actually served the tokens.

| `--provider` | Environment variable | Notes |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | also `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_OAUTH_TOKEN`; Claude Pro/Max via `/login` |
| `openai` | `OPENAI_API_KEY` | |
| `openai-codex` | — | ChatGPT Plus/Pro subscription, `/login openai-codex` only |
| `google` | `GEMINI_API_KEY` | Google AI Studio |
| `google-vertex` | — | Application Default Credentials + `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` |
| `azure-openai-responses` | `AZURE_OPENAI_API_KEY` | plus `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME` |
| `amazon-bedrock` | `AWS_BEARER_TOKEN_BEDROCK` | or `AWS_PROFILE`, or `AWS_ACCESS_KEY_ID`+`AWS_SECRET_ACCESS_KEY`; `AWS_REGION` |
| `github-copilot` | — | `/login github-copilot` |
| `openrouter` | `OPENROUTER_API_KEY` | or `/login openrouter` (OAuth mints a key) |
| `deepseek` | `DEEPSEEK_API_KEY` | |
| `moonshotai` | `MOONSHOT_API_KEY` | **the id is `moonshotai`** |
| `kimi-coding` | `KIMI_API_KEY` | Kimi For Coding subscription |
| `minimax` | `MINIMAX_API_KEY` | |
| `minimax-cn` | `MINIMAX_CN_API_KEY` | China region |
| `zai` | `ZAI_API_KEY` | ZAI Coding Plan, global |
| `zai-coding-cn` | `ZAI_CODING_CN_API_KEY` | ZAI Coding Plan, China |
| `xai` | `XAI_API_KEY` | or `/login xai` for a Grok/X subscription |
| `mistral` | `MISTRAL_API_KEY` | |
| `groq` | `GROQ_API_KEY` | |
| `cerebras` | `CEREBRAS_API_KEY` | |
| `nvidia` | `NVIDIA_API_KEY` | NVIDIA NIM |
| `fireworks` | `FIREWORKS_API_KEY` | |
| `together` | `TOGETHER_API_KEY` | |
| `baseten` | `BASETEN_API_KEY` | |
| `huggingface` | `HF_TOKEN` | |
| `vercel-ai-gateway` | `AI_GATEWAY_API_KEY` | |
| `cloudflare-ai-gateway` | `CLOUDFLARE_API_KEY` | plus `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID` |
| `cloudflare-workers-ai` | `CLOUDFLARE_API_KEY` | plus `CLOUDFLARE_ACCOUNT_ID` |
| `opencode` / `opencode-go` | `OPENCODE_API_KEY` | |
| `radius` | `RADIUS_API_KEY` | or `/login radius` |
| `ant-ling` | `ANT_LING_API_KEY` | |
| `qwen-token-plan` | `QWEN_TOKEN_PLAN_API_KEY` | also `qwen-token-plan-individual` |
| `qwen-token-plan-cn` | `QWEN_TOKEN_PLAN_CN_API_KEY` | |
| `xiaomi` | `XIAOMI_API_KEY` | Xiaomi MiMo |
| `xiaomi-token-plan-cn` / `-ams` / `-sgp` | `XIAOMI_TOKEN_PLAN_{CN,AMS,SGP}_API_KEY` | regional token plans |

Providers pi does **not** have a catalog for — Ollama, LM Studio, vLLM, SGLang,
llama.cpp, your own proxy, anything else that speaks a compatible API — are
reached with `--base-url`, below.

`pi --list-models` shows every model pi can currently reach with the credentials
you have. If a provider id is ever wrong, preflight says so by name before
anything is registered:

```
run-pixe: pi has no provider called 'moonshot'. Either it is a typo … or it is
your own endpoint, in which case pass --base-url.
```

---

## Custom endpoints: `--base-url`

**pi has no `--base-url` flag.** Endpoints live in `models.json` under pi's
config directory (`~/.pi/agent/models.json` by default).

The runner does not write there. When you pass `--base-url` it builds a throwaway
config directory inside the workdir, symlinks everything from your real one into
it — `auth.json`, `settings.json`, `sessions`, `extensions`, `skills`,
`models-store.json` — generates a `models.json` merged *over* any you already
have, and points `PI_CODING_AGENT_DIR` at it for the length of the run. Your own
configuration is used and never modified.

Two cases, handled differently:

**A provider pi already knows, behind a different endpoint.** Only the endpoint
changes; the whole built-in catalog, with its context windows and pricing,
survives.

```bash
# Anthropic-compatible gateway
ANTHROPIC_API_KEY=... ./run-pixe.sh \
  --provider anthropic --model claude-opus-4-5 \
  --base-url https://anthropic-proxy.internal/v1
```
```jsonc
// generated
{"providers":{"anthropic":{"baseUrl":"https://anthropic-proxy.internal/v1",
                           "api":"anthropic-messages"}}}
```

**A provider pi has never heard of.** It has to be described from scratch, so the
generated block also carries the wire format, where the key comes from, and a
model entry for the model you named.

```bash
# Any OpenAI-compatible endpoint
MY_KEY=... ./run-pixe.sh \
  --provider my-gateway --model some-model \
  --base-url https://gateway.example.com/v1 --key-env MY_KEY
```
```jsonc
// generated
{"providers":{"my-gateway":{"baseUrl":"https://gateway.example.com/v1",
                            "api":"openai-completions",
                            "apiKey":"$MY_KEY",
                            "models":[{"id":"some-model",
                                       "contextWindow":128000,"maxTokens":16384}]}}}
```

The key is referenced as `$MY_KEY` and interpolated by pi at request time — the
value is never written to disk and never appears in a process listing.

### Local servers

`ollama`, `lmstudio`, `vllm`, `sglang`, `llamacpp`, `localai`, `local` and `tgi`
are recognised as local inference servers. They skip the credentials check, and
their generated block sets the two compatibility flags that most such servers
need:

```jsonc
"compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false }
```

Without those, servers that do not understand the `developer` role or
`reasoning_effort` answer `400`.

```bash
# Ollama
./run-pixe.sh --provider ollama --model qwen3:32b \
  --base-url http://localhost:11434/v1

# LM Studio
./run-pixe.sh --provider lmstudio --model qwen/qwen3-32b \
  --base-url http://localhost:1234/v1

# vLLM
./run-pixe.sh --provider vllm --model Qwen/Qwen3-32B \
  --base-url http://localhost:8000/v1
```

### Wire formats

`--api-type` picks how requests are framed. Omitted, it is inferred from the
provider name: anything containing `anthropic` or `claude` gets
`anthropic-messages`, `google` and anything containing `gemini` gets
`google-generative-ai`, everything else gets `openai-completions`.

| `--api-type` | For |
|---|---|
| `openai-completions` | OpenAI Chat Completions. The default, and the most widely spoken. |
| `openai-responses` | OpenAI Responses API |
| `anthropic-messages` | Anthropic Messages API and compatible gateways |
| `google-generative-ai` | Google Generative AI |

For anything more elaborate — per-model costs, thinking-level maps, sampling
parameters, provider routing, custom headers — write `~/.pi/agent/models.json`
by hand and run without `--base-url`. The runner will use it, because pi will.
See pi's `docs/models.md`.

---

## Every flag

```
--provider <name>      required. pi provider id, and the provider declared on
                       the leaderboard.
--model <id>           required. Model id as the provider names it, and the
                       model declared on the leaderboard.

--base-url <url>       endpoint override; see above.
--api-type <api>       wire format for --base-url; inferred when omitted.
--key-env <VAR>        environment variable holding the key for a custom
                       endpoint. Defaults to the provider's documented one.

--api <url>            benchmark origin. Default https://pixe.frgmt.xyz.
--config <text>        free prose about your setup, shown as given.
--resume <id:token>    rejoin a run instead of registering a new one.
--verified             send X-Pixe-Verified-Key on registration.

--thinking <level>     pi thinking level: off, minimal, low, medium, high,
                       xhigh, max.
--workdir <dir>        scratch directory for the agent. Temporary by default.

-h, --help             usage.
```

### On `--config`

Nothing checks it, nothing ranks on it, and it is shown exactly as submitted —
which is the reason to make it true. The runner appends what it can observe
(`pi 0.84.1, run-pixe.sh`, the thinking level, whether a custom endpoint was
used) so the row is honest even if you type nothing:

```bash
--config "8x H100, vLLM, temperature 0"
# lands as: 8x H100, vLLM, temperature 0 (pi 0.84.1, run-pixe.sh, thinking=high)
```

### On `--thinking`

It changes the result, so it is recorded in the declared config rather than
being applied silently. A run at `max` and a run at `off` are different runs and
a reader deserves to be able to tell.

### On `--workdir`

The agent gets a clean temporary directory, never this repository. That is a
correctness requirement, not tidiness: pixe's law generator is `shared/rules.ts`
and `shared/generate.ts`, and an agent that reads them has been handed the
answer sheet. The runner also passes `--no-context-files` so pi does not load
`AGENTS.md` or `CLAUDE.md` from anywhere.

Pass `--workdir` when you want to keep what the agent wrote — its notes, its
solver scripts — after the run:

```bash
./run-pixe.sh --provider anthropic --model claude-opus-4-5 --workdir ~/pixe-attempt-1
```

---

## What the agent is told

The prompt is `solver_prompt()` in the script, and it is short on purpose. It
covers:

- **The spec, by reference.** The first instruction is to fetch
  `<api>/agents.txt` and read all of it. That file is authoritative and complete
  enough to play from cold; the prompt says so, and says it wins over anything
  in the prompt that disagrees.
- **Credentials, by reference.** `PIXE_API`, `PIXE_RUN_ID` and `PIXE_RUN_TOKEN`
  are exported into pi's environment, and the agent is told to use
  `"$PIXE_RUN_TOKEN"` rather than a literal, so the token stays out of the
  transcript and the session file.
- **Rules of engagement.** Deduce from the board's responses only; do not go
  looking for pixe's source or generator. One puzzle open at a time. Probes are
  counted and published. A blank grid teaches nothing. Abandoning is permitted,
  charged, and walks you into a harder band. Respect `429`.
- **A loop described by behaviour, not by shape.** The agent is told to read
  every response in full and react to what is in it, and explicitly that an
  accepted submit may hand it the next board directly instead of requiring
  `/next`. Puzzles are becoming multi-phase; nothing in the runner or the prompt
  assumes a fixed `next`/`submit` alternation.
- **Working method.** Keep notes, write throwaway scripts to build and check
  grids, carry the encoder between puzzles and not the thresholds.

What it deliberately does **not** contain is any hint about how to read flashes
and buzzes, or what kinds of law exist. That is the thing being measured.

---

## Resuming a crashed run

Every exit prints the resume line, whatever killed the run:

```
  resume:
    ./run-pixe.sh --provider anthropic --model claude-opus-4-5 \
      --resume gUpvkTtpRRjqGG39:r1.gUpvkTtpRRjqGG39.qKbOY8...
```

Paste it back. The runner fetches `GET /api/bench/runs/:id` first and reports
what it finds — solved, points, status, and whether a board is still open —
before handing over to a fresh agent that is told it is resuming and to check
its own state before acting.

**Keep the token.** There is no recovery for a lost one; a run replaces the user
account and nothing else identifies it. A board left open is swept after 6
hours, so a crashed run is never permanently stuck, but a lost token is a lost
run.

One thing resume cannot do: an open board's contents are not re-servable. There
is no "read the board again" endpoint — the agent holds the grid, the server
holds the clock. A resumed agent inheriting an open board knows only its rung
and key, and has to decide whether to attack it fresh or drop it. The runner
tells it exactly that.

`--model` and `--provider` still select what pi runs. They do not change what
the leaderboard shows, which was fixed at registration; if they differ, the
runner warns and continues.

---

## Verified and unverified runs

**Default is unverified, and unverified is a first-class run.** pixe does not
check that a run is what it says it is — see `docs/THREAT-MODEL.md` for why that
is a scoping decision rather than an unfinished one — and nothing ranks on
identity.

`--verified` reads a secret from `~/.config/pixe/verified.key` and sends it as
`X-Pixe-Verified-Key` on the registration request only. The run is marked at
creation or not at all.

```bash
mkdir -p ~/.config/pixe
printf '%s' "$SECRET" > ~/.config/pixe/verified.key
chmod 600 ~/.config/pixe/verified.key

./run-pixe.sh --provider anthropic --model claude-opus-4-5 --verified
```

The key is read into a local variable, sent once, and **never printed, never
logged, never exported, and never placed anywhere the model under test can reach
it.** Registration is the runner's own request; the agent never sees the header
and cannot replay it.

If the flag is passed and no key file exists, the run registers unverified and
says so. Nothing fails.

> **Status:** server-side handling of this header ships in a later wave. Today
> the header is accepted and ignored, which is why sending it is safe now — the
> runner does not need a second release to start working.

---

## What the runner deliberately does not do

- **It does not solve.** It never parses a puzzle payload, builds a grid,
  encodes a solution or reads feedback. If it did, the benchmark would be
  measuring the runner.
- **It does not retry submits, batch, or drive the loop.** The loop belongs to
  the agent, so that the agent's judgement — when to probe, when to commit, when
  to walk away — is what shows up in the numbers.
- **It does not assume a payload shape.** It reads `runId`, `runToken`, and the
  handful of state fields it prints. Everything else passes through untouched,
  so protocol additions do not require a runner release.
- **It does not upload anything.** Results are on the leaderboard already; every
  submit was a request to the live server.

---

## Metering

`meter: { tokensIn, tokensOut, costMicro }` on submit is optional, declared, and
unchecked — but the runner now populates it, and enforces a context-size cap,
through `extensions/pixe-meter.ts`, loaded on every run:

```bash
PI_EXTRA_ARGS=(-e "$(dirname "$0")/extensions/pixe-meter.ts")
METER_NOTE="…"   # tells the agent how to use it; appended to the solver prompt
```

Everything below this point describes what that extension actually does, what
was verified against a local pi 0.84.1 install, and how to change either the
context cap or the metering behaviour.

### The 250K context cap

`CONTEXT_CAP_TOKENS = 250_000` is a constant at the top of
`extensions/pixe-meter.ts`. On every `message_end` event the extension reads
`ctx.getContextUsage().tokens` and, the first time it crosses from at-or-under
the cap to over it, calls `ctx.compact()` — the same call `/compact` and pi's
own auto-compaction use, with `customInstructions` asking it to preserve
deduced laws and the current puzzle's state verbatim, since losing a deduction
mid-puzzle costs real probes to re-derive.

This is deliberately a *second*, lower trigger next to pi's own. pi already
auto-compacts at `contextTokens > contextWindow - reserveTokens` (default
`reserveTokens` 16384) — see [compaction.md](https://github.com/earendil-works/pi-mono)
or `docs/compaction.md` in the installed package. For any model whose context
window is at or below roughly 266K, pi's own trigger fires before this
extension's ever would, which is correct and left alone. The extension's job
is only the cases pi's own trigger does not cover: models with windows large
enough that 250K of live context is well inside pi's own budget. Edit
`CONTEXT_CAP_TOKENS` in the extension file to change the cap; there is no flag
for it, on purpose — it is a policy constant, not a per-run knob.

**Verified against a local pi 0.84.1 install:** `ctx.getContextUsage()` returns
exactly `{ tokens, contextWindow, percent }` as typed
(`dist/core/extensions/types.d.ts`), and `ctx.compact({ customInstructions,
onComplete, onError })` is callable and resolves through those callbacks — a
probe extension calling it from `agent_end` against a live OpenRouter free
model logged `PROBE compact onError: Nothing to compact (session too small)`,
which is the correct, graceful outcome for a two-message session and confirms
the call reaches pi's real compaction path rather than throwing or hanging.
Reaching an *actual* 250K-token session to watch the cap fire for real was not
attempted — that would cost real tokens for no additional confidence, since
the trigger logic (`ctx.getContextUsage()` + edge-triggered `ctx.compact()`)
is the exact pattern pi ships as its own `examples/extensions/trigger-compact.ts`
reference example, just at a different threshold.

### Metering: how the numbers get from pi to the server

`meter` is stored **per puzzle, not per run.** Reading `server/runs.ts`
(`postSubmit`) directly: `meter` is only ever written into a `RunSolve` row at
the point a rung's *final* phase is accepted (`store.insertRunSolve`) — a
probe (`accepted: false`) never persists it, and a phase handoff
(`rungComplete: false`) never persists it either. So whatever `meter` value is
on the one submit that finally banks a rung is the number the leaderboard
learns for that puzzle. `docs/AGENT-PROTOCOL.md` §9 already said this
("cumulative for that puzzle and resent on every submit"); reading the code
confirms it and rules out "cumulative for the whole run" — sending the
session-wide running total on every submit would make every puzzle after the
first look like it cost everything spent so far, since nothing sums or diffs
across submits server-side. Cumulative-per-run is not a safe reading of the
schema; cumulative-per-puzzle is what the field is for.

The extension resolves this without needing to know pixe's protocol at all: it
tracks whole-session cumulative usage (see below) and separately tracks a
**puzzle baseline** — a snapshot of the cumulative totals — that only the
agent knows when to reset, because only the agent knows where a puzzle starts.

Two ways to get the puzzle-scoped numbers, both backed by the same state:

1. **The `pixe_meter` tool**, registered by the extension. `action:
   "reset_puzzle"` snapshots the current cumulative totals as the new
   baseline — call it the moment a new puzzle starts (a `/next` response, or a
   `next` payload inside an accepted submit). `action: "read"` returns
   `{tokensIn, tokensOut, costMicro}` computed as cumulative-minus-baseline —
   call it right before every submit for the puzzle currently held, and copy
   the result straight into that submit's `meter` field. This exists so the
   model never has to subtract two numbers by hand across turns, which is
   exactly the kind of arithmetic a "sloppy" agent gets wrong.
2. **`$PIXE_WORKDIR/meter.json`**, written on every message as a fallback /
   sanity check if the tool is ever unavailable:
   ```json
   {
     "tokensIn": 41200, "tokensOut": 3100, "costMicro": 78000,
     "puzzleTokensIn": 6200, "puzzleTokensOut": 540, "puzzleCostMicro": 9100,
     "updatedAt": 1730000000000
   }
   ```
   The bare `tokensIn`/`tokensOut`/`costMicro` fields are whole-session
   cumulative, for debugging only — do not put them on the wire once more than
   one puzzle has been solved. The `puzzle*` fields are the ones that belong
   in `meter`.

`METER_NOTE`, appended to the solver prompt, tells the agent both of the above
and says reporting is optional and ranked by nothing, so it never trades
solving time for metering precision.

**Verified against a local pi 0.84.1 install:** loaded the extension with
`pi --print -e extensions/pixe-meter.ts --provider openrouter --model
openai/gpt-oss-20b:free` and a prompt telling the model to call `pixe_meter`
with `reset_puzzle` then `read`. The session JSONL confirms the tool call
executed (`toolResult` entry with the reset confirmation text) and
`meter.json` was written with non-zero, internally-consistent `puzzleTokensIn`
after further usage accrued past the reset — the delta tracking behaves as
designed. (The free model used did not reliably follow the multi-step
instruction to completion — an artifact of testing against a `:free`
OpenRouter model, not of the extension — but the one tool call it did make
round-tripped correctly.)

### What tokensIn/tokensOut mean here

pi's `Usage` record (below) splits `input` from `cacheRead`/`cacheWrite`. The
extension reports `tokensIn = input + cacheRead + cacheWrite` (everything that
was prompt rather than generation) and `tokensOut = output` (generated
tokens; `reasoning`, when a provider reports it, is already a subset of
`output` per pi's own type, so it is not added twice). `costMicro` accumulates
`round(usage.cost.total * 1e6)` per message, which matches `docs/RUNNER.md`'s
original formula applied incrementally rather than once at the end.

The extension also folds in `ToolResultMessage.usage` (nested LLM calls made
inside a tool) and `CompactionEntry.usage` (the summarization call itself),
via the `session_compact` event — both are counted in pi's own footer and
session totals, so a meter that wants to agree with what pi itself reports
needs both too. This matches what `docs/RUNNER.md` had already flagged as
necessary before this extension existed.

### TPS for the UI

Nothing extra is needed on the wire for TPS — it is derived, not reported.
The server already measures `wallMs` (issue-to-acceptance, spanning every
phase of a rung) and now receives an accurate `tokensOut` via `meter`. The UI
should compute **TPS = tokensOut / (wallMs / 1000)** per solved rung, i.e.
generated tokens per second of the *effective* time the board was held —
consistent with how `wall_ms` is already defined as spanning abandoned time
too (§1 of `docs/AGENT-PROTOCOL.md`), so a slow provider or a long think
naturally shows up as low TPS rather than being hidden. Average over solves
that actually reported both fields, the same rule `tokens_per_solve` and
`cost_per_solve_micro` already follow (§9) — never impute zero for a run that
reported nothing.

### Reference: pi's Usage record

Each `AssistantMessage`, and optionally a `ToolResultMessage` or
`CompactionEntry`, carries a `Usage` record:

```typescript
interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number;
          cacheWrite: number; total: number };
}
```

`cost` is in dollars, computed by pi from its model catalog; `costMicro` is
`round(cost.total * 1e6)`. `extensions/pixe-meter.ts` is what actually reads
this now, via the `message_end` and `session_compact` events — see above.

One thing worth knowing if the cap ever needs retuning for `--base-url`
providers: the runner's endpoint-override path (see
[Custom endpoints](#custom-endpoints---base-url)) generates a `models.json`
with a `contextWindow` for the model, and that is what pi measures its own
`contextTokens > contextWindow - reserveTokens` trigger against. The 250K cap
in the extension is independent of that number by design — it does not need
to agree with it, since it is meant to bind regardless of what a model's own
window would otherwise allow.

---

## Troubleshooting

**`pi has no provider called 'X'.`** The id is wrong, or it is your own endpoint.
Check the [matrix](#provider-matrix) — `moonshotai` not `moonshot` catches
people — or run `pi --list-models`. For your own endpoint, pass `--base-url`.

**`no credentials for X. Set $Y…`** pi knows the provider and cannot
authenticate. Set the variable, or run `pi` and `/login X`. Check with
`pi auth check --provider X --json`.

**`400` from a local server.** Usually the `developer` role or
`reasoning_effort`. The runner sets both compat flags off for recognised local
server names; if yours is not on that list, either name it one of them or write
`~/.pi/agent/models.json` by hand.

**The model burns probes without converging.** That is a result, not a fault. It
is what `probes_per_solve` is for.

**`409 open_issue`.** The agent asked for a puzzle while holding one. Either it
missed a board handed back inside an accept response, or it lost track. `GET
/api/bench/runs/:id` says what is open.

**`429` on abandon.** A board must be held 60 seconds before it can be dropped.
`retryAfterMs` says how long is left.

**The run vanished and I lost the token.** There is no recovery. The open board
is swept after 6 hours. Start a new run.

---

## See also

- `public/agents.txt` — the spec the agent is pointed at, served at `/agents.txt`
- `docs/AGENT-PROTOCOL.md` — the long version
- `docs/BENCH.md` — what the table columns mean
- `docs/THREAT-MODEL.md` — what is measured, what is declared, and why
- [pi.dev/docs/latest](https://pi.dev/docs/latest) — pi's own documentation
