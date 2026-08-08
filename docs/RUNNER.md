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
unchecked. The runner does not populate it yet. **This section records what has
already been established about pi so the work is not researched twice.**

There is a marked seam in the script:

```bash
# METERING SEAM — owned by a later agent, left deliberately empty
PI_EXTRA_ARGS=()
METER_NOTE=""
```

`PI_EXTRA_ARGS` is spliced into the pi invocation and `METER_NOTE` is appended
to the solver prompt. Nothing else needs to change.

### pi reports usage on every assistant message

Each `AssistantMessage` in a session carries a `Usage` record:

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

`cost` is in dollars, computed by pi from its model catalog. `costMicro` is
millionths of a dollar, so `costMicro = round(cost.total * 1e6)`.

`ToolResultMessage` has an optional `usage` too, for nested LLM work done inside
a tool. Compaction entries also carry usage for the summary generation, and pi
counts it in session totals — so should any meter that wants to match pi's own
footer.

### Three ways to get at it

1. **`--mode json`.** Every session event as JSON lines on stdout. The first line
   is a session header; `message_end` carries the final authoritative message
   including `usage`. `message_update` events are delta-only and carry no
   cumulative snapshot. This replaces `--print`, so the seam would swap the mode
   and tee the stream.
   ```bash
   pi --mode json "…" | jq -c 'select(.type=="message_end") | .message.usage'
   ```
2. **The session JSONL.** Sessions are written to `~/.pi/agent/sessions/`,
   organised by working directory. Inside the bash tool, `PI_SESSION_FILE` is the
   absolute path to the current session file (unset for ephemeral sessions), so
   an agent's own curl call could read its running total straight off disk. Also
   available to bash tools: `PI_SESSION_ID`, `PI_PROVIDER`, `PI_MODEL`,
   `PI_REASONING_LEVEL`. The runner currently uses a normal (persistent) session
   named `pixe <runId>`, so `PI_SESSION_FILE` is set.
3. **An extension.** The most direct route, and the one the seam expects.

### Extension API, the relevant parts

TypeScript, loaded with `-e <path>`, repeatable. `--no-extensions` disables
discovery while leaving explicit `-e` paths working, which is worth using so a
benchmark run is not perturbed by whatever the operator has installed.

- `pi.on(event, handler)` — the event bus. Agent events (`agent_start`,
  `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`,
  `agent_end`), tool events (`tool_execution_start` / `_update` / `_end`),
  model events, session events.
- `ctx.getContextUsage()` — current context usage for the active model. Uses the
  last assistant usage where available, then estimates the trailing messages.
  This is the thing to poll for a 250K threshold.
- `ctx.compact({ customInstructions, onComplete, onError })` — trigger compaction
  without awaiting it.
- `pi.registerTool(definition)` — a first-class alternative to curl-in-bash, if a
  future runner wants the meter attached to the submit call itself rather than
  read out of band.
- `pi.registerFlag(name, options)` / `pi.getFlag(name)` — extensions can add
  their own CLI flags, so a meter extension can take its own configuration
  without `run-pixe.sh` having to know about it.
- `pi.appendEntry(customType, data?)`, `pi.exec(command, args, options?)`,
  `pi.setSessionName(name)`.
- `session_before_compact` — hook for custom summarisation. Relevant if compaction
  must preserve the deduction notes verbatim, which it probably must: a summary
  that loses "Mint is never adjacent to Ochre" costs probes to re-derive.

### Auto-compaction already exists

pi compacts automatically when `contextTokens > contextWindow - reserveTokens`.
Defaults: `reserveTokens` 16384, `keepRecentTokens` 20000, configurable under
`compaction` in `~/.pi/agent/settings.json` or `<project>/.pi/settings.json`, and
disableable with `"enabled": false`.

So a "compact at 250K" requirement is a *policy* on top of an existing mechanism,
not a mechanism to build: watch `ctx.getContextUsage()` and call `ctx.compact()`
early, or raise `reserveTokens` for a model whose context window is larger than
the budget you want to run at. Note that the runner's `--base-url` path already
generates a `models.json` with `contextWindow`, which is what pi measures the
threshold against — a meter extension and that generated file need to agree.

### Two things worth deciding early

- **Where the numbers cross over.** The meter lives in pi; the submit is a curl
  call the agent makes. Either the extension writes a running total to a file in
  the workdir that the prompt tells the agent to read and include, or submits
  move into a registered tool that attaches the meter itself. The second is
  tidier and changes what the agent is asked to do; the first changes nothing
  and is approximate.
- **Cumulative per puzzle.** The protocol wants `meter` cumulative per puzzle,
  resent on each submit, with the last value before acceptance being the one
  recorded. pi's usage is per message and cumulative per session. Something has
  to hold the per-puzzle boundary, and only the agent knows where it is.

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
