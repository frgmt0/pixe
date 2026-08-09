#!/usr/bin/env bash
#
# run-pixe.sh — the official pixe benchmark runner.
#
# pixe is a pure API benchmark: a 64x64 grid whose laws are never stated, only
# complained about. This script does the small, boring, deterministic half of a
# benchmark run — check the tooling, register the run, hand an agent its
# credentials, and print the resume incantation when it is over.
#
# It does NOT solve anything. It never parses a puzzle payload, never builds a
# grid, and never inspects feedback. Every deduction belongs to the model under
# test, which is the entire point: a runner that helped would be measuring
# itself. The solving loop lives inside the pi coding agent (https://pi.dev),
# driven by the prompt in solver_prompt() below and executed with curl.
#
# Usage:  ./run-pixe.sh --provider anthropic --model claude-opus-4-5
# Docs:   docs/RUNNER.md
#
set -euo pipefail

readonly PIXE_DEFAULT_API="https://pixe.frgmt.xyz"
readonly PI_INSTALL_ONELINER="curl -fsSL https://pi.dev/install.sh | sh"
readonly VERIFIED_KEY_PATH="${HOME}/.config/pixe/verified.key"

# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------

PROVIDER=""          # pi provider id, and the provider declared to the board
MODEL=""             # pi model id, and the model declared to the board
BASE_URL=""          # optional endpoint override (compatible APIs, local servers)
API_TYPE=""          # optional wire format for --base-url; inferred when omitted
KEY_ENV=""           # optional env var holding the key for a custom endpoint
API_ORIGIN="$PIXE_DEFAULT_API"
CONFIG=""            # declared setup note, free prose, ranked by nothing
RESUME=""            # "<runId>:<runToken>" for crash recovery
THINKING=""          # pi thinking level, passed through and declared in config
WORKDIR=""           # scratch dir the agent works in; created if not given
VERIFIED=0

usage() {
  cat <<USAGE
run-pixe.sh — run the pixe benchmark with the pi coding agent.

  pixe is a 64x64 deduction puzzle. Every board hides its own laws about which
  colours may go where and which may sit next to each other, and the agent is
  told none of them. It paints, the grid complains, and it works out the rest.
  Results post to the leaderboard as they happen, because every submit is a
  request to the live server.

  ./run-pixe.sh --provider <name> --model <id> [options]

REQUIRED
  --provider <name>     Provider to run the model on. This is both the pi
                        provider id and the provider declared on the
                        leaderboard, so name what actually served the tokens.
                        e.g. anthropic, openai, openrouter, deepseek, moonshot,
                        minimax, google, groq, ollama
  --model <id>          Model id, as the provider names it. Also declared on
                        the leaderboard. e.g. claude-opus-4-5, gpt-5.2,
                        deepseek/deepseek-v3.2, qwen3:32b

ENDPOINT
  --base-url <url>      Point the provider at a different endpoint: an
                        OpenAI-compatible or Anthropic-compatible gateway, a
                        proxy, or a local server such as Ollama, vLLM or
                        LM Studio. pi has no --base-url flag of its own, so
                        this is applied through a generated models.json in a
                        throwaway config directory. Your own pi config is
                        symlinked in and never written to.
  --api-type <api>      Wire format for --base-url. One of
                        openai-completions (default), openai-responses,
                        anthropic-messages, google-generative-ai.
                        Inferred from the provider name when omitted.
  --key-env <VAR>       Environment variable holding the API key for a custom
                        endpoint. Defaults to the provider's documented
                        variable; keyless local servers need neither.

BENCHMARK
  --api <url>           Benchmark origin. Default ${PIXE_DEFAULT_API}
  --config <text>       Free prose describing your setup, shown on the board
                        exactly as given and ranked by nothing. The runner
                        appends what it knows (pi version, thinking level) so
                        the row is honest without you typing it.
  --resume <id:token>   Rejoin a run after a crash instead of registering a new
                        one. Takes the runId and runToken printed at startup,
                        colon separated. The run's state is fetched first, so
                        the agent knows whether it still holds a board.
  --verified            Send X-Pixe-Verified-Key with the registration request,
                        read from ~/.config/pixe/verified.key. Optional, off by
                        default, and an unverified run is a first-class run.
                        The key is never printed and never reaches the model.

AGENT
  --thinking <level>    pi thinking level: off, minimal, low, medium, high,
                        xhigh, max. Recorded in the declared config, because it
                        changes the result and readers deserve to know.
  --workdir <dir>       Scratch directory the agent works in. A fresh temporary
                        directory by default. Deliberately NOT this repository:
                        pixe's own law generator lives in shared/, and an agent
                        that reads it is not deducing anything.

  -h, --help            This text.

EXAMPLES
  # Anthropic, straight from the API
  ANTHROPIC_API_KEY=sk-ant-... ./run-pixe.sh --provider anthropic --model claude-opus-4-5

  # OpenRouter, thinking turned up
  OPENROUTER_API_KEY=sk-or-... ./run-pixe.sh \\
      --provider openrouter --model anthropic/claude-sonnet-4.6 --thinking high

  # A local Ollama server, no key needed
  ./run-pixe.sh --provider ollama --model qwen3:32b \\
      --base-url http://localhost:11434/v1

  # Any OpenAI-compatible endpoint
  MY_KEY=... ./run-pixe.sh --provider my-gateway --model some-model \\
      --base-url https://gateway.example.com/v1 --key-env MY_KEY

  # Pick up a run that died
  ./run-pixe.sh --provider anthropic --model claude-opus-4-5 \\
      --resume gUpvkTtpRRjqGG39:r1.gUpvkTtpRRjqGG39.qKbOY8...

See docs/RUNNER.md for the full provider matrix and ${PIXE_DEFAULT_API}/agents.txt
for the protocol the agent is handed.
USAGE
}

die() { printf 'run-pixe: %s\n' "$*" >&2; exit 1; }
note() { printf '  %s\n' "$*" >&2; }
event() { printf '  %s  %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
head_line() { printf '\n%s\n' "$*" >&2; }

need_value() { [ $# -ge 2 ] && [ -n "${2:-}" ] || die "$1 needs a value"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --provider)  need_value "$@"; PROVIDER="$2"; shift 2 ;;
    --model)     need_value "$@"; MODEL="$2"; shift 2 ;;
    --base-url)  need_value "$@"; BASE_URL="$2"; shift 2 ;;
    --api-type)  need_value "$@"; API_TYPE="$2"; shift 2 ;;
    --key-env)   need_value "$@"; KEY_ENV="$2"; shift 2 ;;
    --api)       need_value "$@"; API_ORIGIN="${2%/}"; shift 2 ;;
    --config)    need_value "$@"; CONFIG="$2"; shift 2 ;;
    --resume)    need_value "$@"; RESUME="$2"; shift 2 ;;
    --thinking)  need_value "$@"; THINKING="$2"; shift 2 ;;
    --workdir)   need_value "$@"; WORKDIR="$2"; shift 2 ;;
    --verified)  VERIFIED=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *)           die "unknown option: $1 (try --help)" ;;
  esac
done

[ -n "$PROVIDER" ] || die "--provider is required (try --help)"
[ -n "$MODEL" ] || die "--model is required (try --help)"

# ---------------------------------------------------------------------------
# Provider knowledge
#
# pi resolves credentials in this order: --api-key, ~/.pi/agent/auth.json
# (which is where OAuth logins land), then the environment. `pi auth check`
# knows all three and is what we actually gate on. The table below is only the
# environment third of it, kept so the failure message can name the variable
# you probably meant to set, and so a custom endpoint knows which variable to
# interpolate. Sourced from pi 0.84's docs/providers.md.
# ---------------------------------------------------------------------------

provider_key_env() {
  case "$1" in
    anthropic)                   echo ANTHROPIC_API_KEY ;;
    openai)                      echo OPENAI_API_KEY ;;
    google)                      echo GEMINI_API_KEY ;;
    azure-openai-responses)      echo AZURE_OPENAI_API_KEY ;;
    deepseek)                    echo DEEPSEEK_API_KEY ;;
    moonshotai)                  echo MOONSHOT_API_KEY ;;
    kimi-coding)                 echo KIMI_API_KEY ;;
    minimax)                     echo MINIMAX_API_KEY ;;
    minimax-cn)                  echo MINIMAX_CN_API_KEY ;;
    openrouter)                  echo OPENROUTER_API_KEY ;;
    vercel-ai-gateway)           echo AI_GATEWAY_API_KEY ;;
    mistral)                     echo MISTRAL_API_KEY ;;
    groq)                        echo GROQ_API_KEY ;;
    cerebras)                    echo CEREBRAS_API_KEY ;;
    xai)                         echo XAI_API_KEY ;;
    nvidia)                      echo NVIDIA_API_KEY ;;
    fireworks)                   echo FIREWORKS_API_KEY ;;
    together)                    echo TOGETHER_API_KEY ;;
    baseten)                     echo BASETEN_API_KEY ;;
    huggingface)                 echo HF_TOKEN ;;
    opencode|opencode-go)        echo OPENCODE_API_KEY ;;
    radius)                      echo RADIUS_API_KEY ;;
    zai)                         echo ZAI_API_KEY ;;
    zai-coding-cn)               echo ZAI_CODING_CN_API_KEY ;;
    ant-ling)                    echo ANT_LING_API_KEY ;;
    cloudflare-ai-gateway|cloudflare-workers-ai) echo CLOUDFLARE_API_KEY ;;
    amazon-bedrock)              echo AWS_BEARER_TOKEN_BEDROCK ;;
    qwen-token-plan|qwen-token-plan-individual) echo QWEN_TOKEN_PLAN_API_KEY ;;
    qwen-token-plan-cn)          echo QWEN_TOKEN_PLAN_CN_API_KEY ;;
    xiaomi)                      echo XIAOMI_API_KEY ;;
    xiaomi-token-plan-cn)        echo XIAOMI_TOKEN_PLAN_CN_API_KEY ;;
    xiaomi-token-plan-ams)       echo XIAOMI_TOKEN_PLAN_AMS_API_KEY ;;
    xiaomi-token-plan-sgp)       echo XIAOMI_TOKEN_PLAN_SGP_API_KEY ;;
    *)                           echo "" ;;
  esac
}

# Ask pi whether it has heard of a provider at all, and if so whether it can
# authenticate to it. Two fields matter:
#
#   status = ready                       usable right now
#   reason = credentials_not_configured  pi knows the provider, has no key
#   reason = provider_not_found          pi has never heard of this name
#
# Asking pi beats any table this script could carry, because it accounts for
# auth.json, OAuth logins and the environment at once, and it stays right when
# pi adds a provider.
pi_auth_field() {
  pi auth check --provider "$1" --json 2>/dev/null | jq -r "(.$2 // \"\")" 2>/dev/null || echo ""
}

# A provider pi has a catalog for keeps that catalog when given a --base-url,
# and only changes endpoint. An unknown one has to be described from scratch,
# model entry included. Reads AUTH_REASON, which preflight has already resolved
# for the one provider this run cares about.
provider_is_builtin() {
  [ "$AUTH_REASON" != "provider_not_found" ]
}

# Local inference servers that generally choke on the `developer` role and on
# `reasoning_effort`. Setting these two compat flags is the difference between
# "works" and "400 Bad Request" on most of them.
provider_is_local_server() {
  case "$1" in
    ollama|lmstudio|lm-studio|vllm|sglang|llamacpp|llama-cpp|localai|local|tgi) return 0 ;;
    *) return 1 ;;
  esac
}

infer_api_type() {
  case "$1" in
    *anthropic*|*claude*) echo anthropic-messages ;;
    google|*gemini*)      echo google-generative-ai ;;
    *)                    echo openai-completions ;;
  esac
}

# ---------------------------------------------------------------------------
# Preflight
#
# Everything that can be known before a single token is spent, checked before
# a single token is spent.
# ---------------------------------------------------------------------------

head_line "preflight"

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required and was not found on PATH"
done
note "curl, jq: ok"

if ! command -v pi >/dev/null 2>&1; then
  cat >&2 <<EOF

run-pixe: the pi coding agent is not installed.

  $PI_INSTALL_ONELINER

  or:  npm install -g --ignore-scripts @earendil-works/pi-coding-agent
  see: https://pi.dev

EOF
  exit 1
fi
PI_VERSION="$(pi --version 2>/dev/null | tail -n 1 | tr -d '[:space:]')"
note "pi: ${PI_VERSION:-unknown}"

# Credentials, and whether the provider exists at all. Both come from pi, which
# is the only thing that can answer either question honestly.
KEY_ENV_NAME="${KEY_ENV:-$(provider_key_env "$PROVIDER")}"
AUTH_STATUS="$(pi_auth_field "$PROVIDER" status)"
AUTH_REASON="$(pi_auth_field "$PROVIDER" reason)"

check_credentials() {
  if [ "$AUTH_STATUS" = "ready" ]; then
    note "auth: pi reports $PROVIDER ready"
    return 0
  fi

  # pi has never heard of this provider name.
  if [ "$AUTH_REASON" = "provider_not_found" ]; then
    if [ -z "$BASE_URL" ]; then
      die "pi has no provider called '$PROVIDER'. Either it is a typo — run 'pi --list-models' or see docs/RUNNER.md for the names pi uses, e.g. 'moonshotai' rather than 'moonshot' — or it is your own endpoint, in which case pass --base-url."
    fi
    if provider_is_local_server "$PROVIDER"; then
      note "auth: skipped, $PROVIDER is a local server"
    elif [ -n "$KEY_ENV_NAME" ] && [ -n "${!KEY_ENV_NAME:-}" ]; then
      note "auth: \$$KEY_ENV_NAME is set"
    elif [ -n "$KEY_ENV" ]; then
      die "--key-env named \$$KEY_ENV, but it is empty or unset."
    else
      note "auth: no key configured for $PROVIDER; assuming the endpoint needs none"
    fi
    return 0
  fi

  # pi knows the provider and cannot authenticate to it.
  if [ -n "$KEY_ENV_NAME" ]; then
    die "no credentials for $PROVIDER. Set \$$KEY_ENV_NAME, or run 'pi' and use /login $PROVIDER."
  fi
  die "no credentials for $PROVIDER${AUTH_REASON:+ ($AUTH_REASON)}. Run 'pi' and use /login $PROVIDER."
}
check_credentials

# ---------------------------------------------------------------------------
# Working directory
#
# The agent gets a clean room, never this repository. shared/generate.ts and
# shared/rules.ts are the law generator; an agent that reads them has been
# handed the answer sheet and is no longer deducing anything. --no-context-files
# below closes the other half of that door.
# ---------------------------------------------------------------------------

WORKDIR_IS_TEMP=0
if [ -z "$WORKDIR" ]; then
  WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/pixe-run.XXXXXXXX")"
  WORKDIR_IS_TEMP=1
else
  mkdir -p "$WORKDIR"
fi
WORKDIR="$(cd "$WORKDIR" && pwd)"
note "workdir: $WORKDIR"

# ---------------------------------------------------------------------------
# Endpoint override
#
# pi has no --base-url flag. Endpoints are configured in models.json under
# $PI_CODING_AGENT_DIR (default ~/.pi/agent). Rather than write to the user's
# config, build a shim directory that symlinks everything in the real one —
# auth.json, sessions, extensions, skills, settings — and supply our own
# models.json, merged over theirs so nothing they configured is lost.
# ---------------------------------------------------------------------------

setup_endpoint_override() {
  local real="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
  local shim="$WORKDIR/.pi-agent"
  local api_type="${API_TYPE:-$(infer_api_type "$PROVIDER")}"

  mkdir -p "$shim"
  if [ -d "$real" ]; then
    local entry base
    for entry in "$real"/* "$real"/.[!.]*; do
      [ -e "$entry" ] || continue
      base="$(basename "$entry")"
      [ "$base" = "models.json" ] && continue
      ln -sfn "$entry" "$shim/$base"
    done
  fi

  # The provider block. A catalogued provider needs only a new endpoint. An
  # unknown one needs to be described: wire format, where the key comes from,
  # and at least the one model we are about to run.
  local block
  block="$(jq -n --arg url "$BASE_URL" --arg api "$api_type" '{baseUrl: $url, api: $api}')"

  if ! provider_is_builtin "$PROVIDER"; then
    local key_ref="local"
    [ -n "$KEY_ENV_NAME" ] && key_ref="\$$KEY_ENV_NAME"
    block="$(jq -n --argjson b "$block" --arg model "$MODEL" --arg key "$key_ref" \
      '$b + {apiKey: $key, models: [{id: $model, contextWindow: 128000, maxTokens: 16384}]}')"
    if provider_is_local_server "$PROVIDER"; then
      block="$(jq -n --argjson b "$block" \
        '$b + {compat: {supportsDeveloperRole: false, supportsReasoningEffort: false}}')"
    fi
  fi

  local existing='{}'
  [ -f "$real/models.json" ] && existing="$(cat "$real/models.json")"
  printf '%s' "$existing" | jq \
    --arg p "$PROVIDER" --argjson block "$block" \
    '.providers //= {} | .providers[$p] = ((.providers[$p] // {}) * $block)' \
    > "$shim/models.json"

  export PI_CODING_AGENT_DIR="$shim"
  note "endpoint: $PROVIDER -> $BASE_URL ($api_type)"
}

[ -n "$BASE_URL" ] && setup_endpoint_override

# ---------------------------------------------------------------------------
# Context cap
#
# The benchmark caps live context at 250K tokens regardless of the model's
# own window. The enforcement is deliberately NOT an extension calling
# ctx.compact(): pi's compact() begins by aborting the in-flight agent run
# and never restarts it, which in --print mode ends the process — one death
# per 250K crossing, observed live. Instead the cap is expressed in pi's own
# terms: native auto-compaction fires at contextWindow - reserveTokens, so
# writing reserveTokens = window - 250000 into the workdir's project
# settings moves the native trigger down to the cap, and pi's own overflow
# path compacts and retries mid-run without dropping anything.
#
# The window comes from pi's model listing (display-rounded; exact for every
# catalogued anthropic window as of pi 0.84.1). A model pi cannot size, or
# whose window is already at or under the cap plus the default reserve, is
# left alone — the default trigger is already at least as strict.
# ---------------------------------------------------------------------------

context_cap_settings() {
  local cap=250000 window num reserve
  window="$(pi --list-models 2>/dev/null | awk -v p="$PROVIDER" -v m="$MODEL" '$1 == p && $2 == m { print $3; exit }')"
  num="${window%[KM]}"
  case "$num" in '' | *[!0-9]*) return 0 ;; esac
  case "$window" in
    *M) window=$((num * 1000000)) ;;
    *K) window=$((num * 1000)) ;;
    *)  window="$num" ;;
  esac
  reserve=$((window - cap))
  [ "$reserve" -le 16384 ] && return 0
  mkdir -p "$WORKDIR/.pi"
  jq -n --argjson r "$reserve" '{compaction: {reserveTokens: $r}}' > "$WORKDIR/.pi/settings.json"
  note "context cap: ${window}-token window, native compaction at ${cap} (reserveTokens=${reserve})"
}
context_cap_settings

# ---------------------------------------------------------------------------
# Declared config
#
# Nothing ranks on this and nothing checks it, which is exactly why it should
# be true. Say what actually ran.
# ---------------------------------------------------------------------------

RUNNER_TAG="pi ${PI_VERSION:-?}, run-pixe.sh"
[ -n "$THINKING" ] && RUNNER_TAG="$RUNNER_TAG, thinking=$THINKING"
[ -n "$BASE_URL" ] && RUNNER_TAG="$RUNNER_TAG, custom endpoint"
if [ -n "$CONFIG" ]; then
  DECLARED_CONFIG="$CONFIG ($RUNNER_TAG)"
else
  DECLARED_CONFIG="$RUNNER_TAG"
fi

# ---------------------------------------------------------------------------
# Register, or rejoin
# ---------------------------------------------------------------------------

RUN_ID=""
RUN_TOKEN=""

register_run() {
  head_line "registering"

  local body headers=()
  body="$(jq -n --arg m "$MODEL" --arg p "$PROVIDER" --arg c "$DECLARED_CONFIG" \
    '{model: $m, provider: $p, config: $c}')"

  # The verified key, if the operator has one. It is read into a local, sent
  # once, and never exported, never logged, and never placed anywhere the model
  # under test can reach it. A run without one is a first-class run.
  if [ "$VERIFIED" -eq 1 ]; then
    if [ -r "$VERIFIED_KEY_PATH" ]; then
      local key
      key="$(tr -d '[:space:]' < "$VERIFIED_KEY_PATH")"
      if [ -n "$key" ]; then
        headers+=(-H "X-Pixe-Verified-Key: $key")
        note "verified: key loaded from $VERIFIED_KEY_PATH"
      else
        note "verified: $VERIFIED_KEY_PATH is empty; registering unverified"
      fi
    else
      note "verified: no key at $VERIFIED_KEY_PATH; registering unverified"
    fi
  fi

  local resp status
  resp="$(curl -sS -w $'\n%{http_code}' -X POST "$API_ORIGIN/api/bench/runs" \
    -H 'content-type: application/json' \
    ${headers[@]+"${headers[@]}"} \
    -d "$body")" || die "could not reach $API_ORIGIN"
  status="$(printf '%s' "$resp" | tail -n 1)"
  resp="$(printf '%s' "$resp" | sed '$d')"

  if [ "$status" != "201" ] && [ "$status" != "200" ]; then
    printf '%s\n' "$resp" >&2
    die "registration failed with HTTP $status"
  fi

  RUN_ID="$(printf '%s' "$resp" | jq -r '.runId // empty')"
  RUN_TOKEN="$(printf '%s' "$resp" | jq -r '.runToken // empty')"
  [ -n "$RUN_ID" ] && [ -n "$RUN_TOKEN" ] || die "registration returned no run token"

  note "run:     $RUN_ID"
  note "dialect: $(printf '%s' "$resp" | jq -r '.dialect // "?"')"
  note "model:   $MODEL on $PROVIDER"
  note "config:  $DECLARED_CONFIG"
}

rejoin_run() {
  head_line "rejoining"

  RUN_ID="${RESUME%%:*}"
  RUN_TOKEN="${RESUME#*:}"
  [ -n "$RUN_ID" ] && [ -n "$RUN_TOKEN" ] && [ "$RUN_ID" != "$RESUME" ] \
    || die "--resume wants <runId>:<runToken>"

  local resp status
  resp="$(curl -sS -w $'\n%{http_code}' "$API_ORIGIN/api/bench/runs/$RUN_ID" \
    -H "Authorization: Bearer $RUN_TOKEN")" || die "could not reach $API_ORIGIN"
  status="$(printf '%s' "$resp" | tail -n 1)"
  resp="$(printf '%s' "$resp" | sed '$d')"
  [ "$status" = "200" ] || { printf '%s\n' "$resp" >&2; die "could not rejoin run $RUN_ID (HTTP $status)"; }

  note "run:      $RUN_ID"
  note "declared: $(printf '%s' "$resp" | jq -r '.model // "?"') on $(printf '%s' "$resp" | jq -r '.provider // "?"')"
  note "banked:   $(printf '%s' "$resp" | jq -r '.solved // 0') solved, $(printf '%s' "$resp" | jq -r '.points // 0') points"
  note "status:   $(printf '%s' "$resp" | jq -r '.status // "?"')"
  if [ "$(printf '%s' "$resp" | jq -r '.open // "null"')" != "null" ]; then
    note "open:     rung $(printf '%s' "$resp" | jq -r '.open.idx'), key $(printf '%s' "$resp" | jq -r '.open.key')"
  else
    note "open:     none"
  fi

  local declared
  declared="$(printf '%s' "$resp" | jq -r '.model // ""')"
  if [ -n "$declared" ] && [ "$declared" != "$MODEL" ]; then
    note "warning:  this run is declared as '$declared' but you asked for '$MODEL'."
    note "          The board will keep showing '$declared'. Start a new run to change it."
  fi
}

if [ -n "$RESUME" ]; then rejoin_run; else register_run; fi

# ---------------------------------------------------------------------------
# Exit summary
#
# Printed whichever way the run ends — solved out, crashed, or Ctrl-C — because
# the resume line is worthless if it only appears on the happy path. A lost
# token is a lost run; there is no recovery on the server side.
# ---------------------------------------------------------------------------

SUMMARISED=0
summarise() {
  local code=$?
  [ "$SUMMARISED" -eq 1 ] && exit "$code"
  SUMMARISED=1

  [ -n "${STATUS_PID:-}" ] && kill "$STATUS_PID" 2>/dev/null || true

  local state solved points bonds ended
  state="$(curl -sS --max-time 10 "$API_ORIGIN/api/bench/runs/$RUN_ID" \
    -H "Authorization: Bearer $RUN_TOKEN" 2>/dev/null || true)"
  solved="$(printf '%s' "$state" | jq -r '.solved // "?"' 2>/dev/null || echo '?')"
  points="$(printf '%s' "$state" | jq -r '.points // "?"' 2>/dev/null || echo '?')"
  bonds="$(printf '%s' "$state" | jq -r '.bonds // "?"' 2>/dev/null || echo '?')"

  # How it ended, if the stop gate recorded one. "abandoned" here means the
  # model was asked "are you sure?" and answered ABANDON — a deliberate,
  # final ending, as opposed to the process merely dying.
  ended=""
  if [ -n "$WORKDIR" ] && [ -f "$WORKDIR/watchdog.json" ]; then
    case "$(jq -r '.outcome // ""' "$WORKDIR/watchdog.json" 2>/dev/null || echo "")" in
      abandoned)    ended="abandoned — model confirmed ABANDON; score is final" ;;
      complete)     ended="ladder complete" ;;
      unresponsive) ended="model stopped answering the stop gate" ;;
    esac
  fi

  cat >&2 <<EOF

────────────────────────────────────────────────────────────────────────
  pixe run finished

  run          $RUN_ID
  declared     $MODEL on $PROVIDER
  banked       $solved solved · $points points · $bonds bonds${ended:+
  ended        $ended}
  leaderboard  $API_ORIGIN
  workdir      $WORKDIR

  resume:
    ./run-pixe.sh --provider $PROVIDER --model $MODEL \\
      --resume $RUN_ID:$RUN_TOKEN

  Keep that token. There is no recovery for a lost one.
────────────────────────────────────────────────────────────────────────
EOF
  if [ "$WORKDIR_IS_TEMP" -eq 1 ]; then
    printf '  The workdir is temporary; copy anything you want out of it.\n\n' >&2
  fi
  exit "$code"
}
trap summarise EXIT INT TERM

# ---------------------------------------------------------------------------
# The solver prompt
#
# The rules of engagement, the credentials, and a pointer at the authoritative
# spec. It deliberately does not teach the game: how to read flashes and buzzes
# is the thing under measurement, and a prompt that explained it would be
# scoring itself. What it does explain is the shape of the API, the budgets,
# and how not to waste requests on things the server will simply refuse.
#
# Note what is absent: any assumption about what an accept response contains
# beyond "read it". Puzzles are becoming multi-phase — accepting one phase can
# return the next phase's payload inside the accept response rather than
# requiring /next — so the loop is described as "read every response and react
# to what is actually in it", not as a fixed next/submit alternation.
# ---------------------------------------------------------------------------

solver_prompt() {
  cat <<PROMPT
You are running the pixe benchmark. This is a live, measured, public run: every
request you make hits the real server and lands on the leaderboard. Work
carefully.

FIRST, BEFORE ANYTHING ELSE

Fetch the specification and read all of it:

    curl -s $API_ORIGIN/agents.txt

That document is authoritative. Where anything below disagrees with it, it
wins. It is complete enough to play from cold: endpoints, payload shapes, grid
encodings, the two feedback channels, the budgets, and what is measured.

YOUR CREDENTIALS

    origin:  $API_ORIGIN
    runId:   $RUN_ID
    token:   in the environment as \$PIXE_RUN_TOKEN

The run is already registered. Do not register another one. Authenticate every
run-scoped request with the token, by reference so it stays out of your
transcript:

    curl -s -X POST "\$PIXE_API/api/bench/runs/\$PIXE_RUN_ID/next" \\
      -H "Authorization: Bearer \$PIXE_RUN_TOKEN"

\$PIXE_API and \$PIXE_RUN_ID are also in your environment. Use curl for every
API call. Use jq to read responses.

WHAT YOU ARE DOING

A 64x64 grid, eight colours, 4096 cells. The board hides its own laws about
which colours may go where and which may sit next to each other, and you are
told none of them. You submit a grid, the board tells you what is wrong with
it, and you work out the laws from the complaints. Fill every cell without
breaking a law and the puzzle is banked; then you get another one, harder,
derived from the grid you just had accepted.

Submitting is also how you observe. A grid that is not a solution is not an
error — it comes back 200 with the complaints attached. Partial grids are
legal submissions. That feedback is the only teacher there is; there is no
hint endpoint and no rule text.

THE LOOP

Take a puzzle, submit grids against it until it is accepted, take the next one.
Repeat until you cannot make progress.

Read every response in full and react to what is actually in it. Do not assume
a response only contains what you saw last time: the payload evolves, and an
accepted submit may hand you your next board directly instead of making you ask
for one. If a response contains a new puzzle, that is the puzzle you are now
working on. Check before you call /next.

RULES OF ENGAGEMENT

- Deduce. Everything you learn must come from the board's own responses. Do not
  go looking for pixe's source, its generator, its rule definitions or any
  write-up of them, on disk or on the web. That is the answer sheet, and using
  it makes the number meaningless.
- One puzzle is open at a time and the server enforces it. Asking for another
  while you hold one is a 409.
- Every unaccepted submit is counted as a probe and published. Probes per solve
  is one of the two things this benchmark ranks on. Think before you submit;
  a submission you already know the answer to is cheaper than three you don't.
- An entirely blank grid tells you nothing — the board stays quiet about laws
  you could still go on to satisfy — so probing one is a wasted request. Once a
  grid is full, silence means solved.
- Time is measured server-side from issue to acceptance. It is the other thing
  ranked. Do not idle on an open board.
- You may abandon a board you cannot crack, but only after holding it 60
  seconds, and it is charged to your score and counted in a public column.
  Abandoning also walks you into a harder band, not an easier one. It is
  occasionally right and never free.
- Budgets: 600 requests per open puzzle, 6 hours before an open board is swept.
  Both are generous. Neither is a resource to spend down.
- If the server answers 429, respect retryAfterMs and wait.

WORKING METHOD

Your working directory is scratch space and it is yours. Use it. Keep a notes
file recording what you have established about the current board's laws and
what you have ruled out; write throwaway scripts to build, check and encode
grids rather than assembling 4096 cells by hand. A script that renders a grid
and diffs it against the returned flashes will pay for itself in the first
puzzle. Rewrite them as you learn more.

Between puzzles, keep only what actually transfers. Each run has its own rule
dialect and each board its own laws, so specific thresholds and colour
assignments do not carry over — but the shape of a good probe, and a working
encoder, do.

WHEN TO STOP

Keep going while you are still banking puzzles. Stop, and say so plainly, when
you are genuinely stuck — repeated abandons, a board you cannot move on after
sustained effort, or the server refusing to make progress. A clear stop with an
honest account of where you got to is a better result than burning requests.

Report at the end: how many puzzles you banked, the hardest rung you reached,
what you worked out about how these boards behave, and where it broke down.
PROMPT
}

# Used both for --resume and for the relaunch loop below: a fresh pi session
# picking up a live run needs telling that it is mid-flight, whichever way the
# previous session ended.
resume_note() {
  cat <<'NOTE'


RESUMING

This run is already in progress and you are picking it up mid-flight. Before
anything else, after reading the spec, fetch your own state:

    curl -s "$PIXE_API/api/bench/runs/$PIXE_RUN_ID" -H "Authorization: Bearer $PIXE_RUN_TOKEN"

It tells you what you have banked and whether a board is still open. If one is,
you are holding it — its contents are not re-servable, so you are working from
nothing but its rung and key. Judge whether to attack it fresh or abandon it and
take a new one, and remember abandoning is charged. If nothing is open, call
/next and begin.
NOTE
}

if [ -n "$RESUME" ]; then RESUME_NOTE="$(resume_note)"; else RESUME_NOTE=""; fi

# ---------------------------------------------------------------------------
# METERING
#
# extensions/pixe-meter.ts does two things inside the pi process, entirely
# locally: (1) caps live context at 250K tokens regardless of the model's own
# window, by watching ctx.getContextUsage() and calling ctx.compact() itself
# when pi's own contextWindow-minus-reserve trigger would not have fired yet;
# (2) accumulates session usage (assistant messages, nested tool usage,
# compaction-summary usage) and writes it to meter.json in the workdir, split
# into whole-session cumulative and per-puzzle-since-last-reset, because the
# server only stores the `meter` value attached to the submit that finally
# accepts a rung (see server/runs.ts, postSubmit) — cumulative-for-the-whole-
# run would overstate every puzzle after the first. It also registers a
# `pixe_meter` tool that does the reset/read arithmetic for the agent instead
# of asking it to subtract two numbers by hand. See docs/RUNNER.md § "Metering"
# for the full design and what was verified against a local pi install.
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# STOP GATE
#
# extensions/pixe-watchdog.ts sits on pi's agent_settled event — the moment
# the model has stopped and pi would otherwise let the session end — and asks
# one neutral question: "Are you sure you want to stop? Reply with exactly the
# single word ABANDON to confirm." It deliberately reveals nothing about
# remaining puzzles or ladder depth: a model told "you have more to do" is
# being steered, and a steered run measures the steering. ABANDON ends the run
# and the score is final; anything else is the model choosing to continue. The
# outcome lands in $PIXE_WORKDIR/watchdog.json so the relaunch loop below can
# tell a deliberate ending from a dead process.
# ---------------------------------------------------------------------------
PI_EXTRA_ARGS=(-e "$(dirname "$0")/extensions/pixe-meter.ts"
               -e "$(dirname "$0")/extensions/pixe-watchdog.ts")
METER_NOTE="

METERING

An extension is loaded that tracks token and cost usage. Your live context is
capped at 250K tokens and compacts automatically when it gets there; you do
not need to do anything about context size yourself.

To report accurately, the pixe server only keeps the \`meter\` value attached
to whichever submit finally accepts a rung — not a running total across the
whole run — so:

- The moment a new puzzle starts (a /next response, or a \`next\` payload
  inside an accepted submit), call the pixe_meter tool with
  action=reset_puzzle before doing anything else with that puzzle.
- Right before every submit request for the puzzle you currently hold, call
  the pixe_meter tool with action=read and put its tokensIn/tokensOut/
  costMicro fields verbatim into that submit's \`meter\` object.

If the tool is ever unavailable, the same numbers are in \$PIXE_WORKDIR/meter.json
as puzzleTokensIn/puzzleTokensOut/puzzleCostMicro. This is optional and ranked
by nothing — best effort beats nothing, but do not let it slow down solving."

# ---------------------------------------------------------------------------
# Launch
#
# --no-context-files keeps this repository's AGENTS.md/CLAUDE.md out of the
# agent's head; combined with the scratch workdir it means the model arrives
# knowing only what the prompt and /agents.txt told it, which is the condition
# the benchmark is supposed to measure under.
#
# The pi process is wrapped in systemd-inhibit where available, holding both
# the idle and sleep inhibitor locks for exactly as long as pi runs. A
# benchmark run is hours of a machine looking idle to everything that watches
# for idleness — hypridle honours these locks (ignore_systemd_inhibit defaults
# to off) and logind will not suspend past them, so neither a screensaver
# cascade nor a sleep can take the run down mid-board.
#
# And because a process can still simply die — a dropped stream aborts pi, a
# power cut kills the box — the launch is a loop, not a call. After every pi
# exit the loop asks two questions: did the watchdog record a deliberate
# ending (ABANDON confirmed, ladder complete, model unresponsive), and does
# the server say the ladder is done? If neither, the exit was an accident and
# pi is relaunched into the same run with the resume briefing, up to
# MAX_RELAUNCHES times. Ctrl-C still ends everything: the INT trap fires in
# this shell and never returns to the loop.
# ---------------------------------------------------------------------------

PI_ARGS=(--print --provider "$PROVIDER" --model "$MODEL" --no-context-files
         --name "pixe $RUN_ID")
[ -n "$THINKING" ] && PI_ARGS+=(--thinking "$THINKING")

export PIXE_API="$API_ORIGIN"
export PIXE_RUN_ID="$RUN_ID"
export PIXE_RUN_TOKEN="$RUN_TOKEN"
export PIXE_WORKDIR="$WORKDIR"

INHIBIT=()
if command -v systemd-inhibit >/dev/null 2>&1; then
  INHIBIT=(systemd-inhibit --what=idle:sleep --who=run-pixe
           --why="pixe benchmark run $RUN_ID" --mode=block)
  note "keep-awake: systemd-inhibit holds idle and sleep while pi runs"
fi

run_field() {
  curl -sS --max-time 10 "$API_ORIGIN/api/bench/runs/$RUN_ID" \
    -H "Authorization: Bearer $RUN_TOKEN" 2>/dev/null \
    | jq -r "(.$1 // \"\") | tostring" 2>/dev/null || echo ""
}

MAX_RELAUNCHES=8

# ---------------------------------------------------------------------------
# Status stream
#
# pi in --print mode says nothing until it is finished, which makes an
# hours-long run indistinguishable from a hung one. This poller asks the
# server — the only honest narrator of a run — every 20 seconds and reports
# just the events worth a line: a rung banked, a new rung opened. It reads the
# same GET run-state endpoint the summary uses, never touches the agent, and
# tells the operator's terminal nothing the leaderboard would not.
# ---------------------------------------------------------------------------

status_stream() {
  local prev_solved=-1 prev_open=""
  local state solved points open_idx
  while :; do
    state="$(curl -sS --max-time 10 "$API_ORIGIN/api/bench/runs/$RUN_ID" \
      -H "Authorization: Bearer $RUN_TOKEN" 2>/dev/null || true)"
    if [ -n "$state" ]; then
      solved="$(printf '%s' "$state" | jq -r '.solved // empty' 2>/dev/null || true)"
      points="$(printf '%s' "$state" | jq -r '.points // empty' 2>/dev/null || true)"
      open_idx="$(printf '%s' "$state" | jq -r '.open.idx // empty' 2>/dev/null || true)"
      if [ -n "$solved" ]; then
        if [ "$prev_solved" -ge 0 ] && [ "$solved" -gt "$prev_solved" ]; then
          event "banked — $solved solved · ${points:-?} points"
        fi
        if [ "$open_idx" != "$prev_open" ]; then
          [ -n "$open_idx" ] && event "holding rung $open_idx"
          prev_open="$open_idx"
        fi
        prev_solved="$solved"
      fi
    fi
    sleep 20
  done
}

head_line "handing off to pi — the solving from here is the model's"
printf '\n' >&2

status_stream &
STATUS_PID=$!

cd "$WORKDIR"
rm -f "$WORKDIR/watchdog.json"

PROMPT="$(solver_prompt)$RESUME_NOTE$METER_NOTE"
RELAUNCHES=0
while :; do
  LAUNCHED_AT="$(date +%s)"
  set +e
  ${INHIBIT[@]+"${INHIBIT[@]}"} pi "${PI_ARGS[@]}" \
    ${PI_EXTRA_ARGS[@]+"${PI_EXTRA_ARGS[@]}"} "$PROMPT"
  PI_EXIT=$?
  set -e

  # A session that ran a while before dying is not the same failure repeating —
  # a run that banks puzzles for an hour and then hits a rate-limit storm
  # deserves the full relaunch budget again, not the tail end of one spent on
  # startup crashes six hours ago.
  if [ "$(( $(date +%s) - LAUNCHED_AT ))" -ge 600 ]; then
    RELAUNCHES=0
  fi

  WATCHDOG_OUTCOME=""
  [ -f "$WORKDIR/watchdog.json" ] && \
    WATCHDOG_OUTCOME="$(jq -r '.outcome // ""' "$WORKDIR/watchdog.json" 2>/dev/null || echo "")"
  case "$WATCHDOG_OUTCOME" in
    abandoned)    note "ended: model confirmed ABANDON — the score is final"; break ;;
    complete)     note "ended: ladder complete"; break ;;
    unresponsive) note "ended: model stopped answering the stop gate"; break ;;
  esac
  [ "$(run_field complete)" = "true" ] && { note "ended: ladder complete"; break; }

  RELAUNCHES=$((RELAUNCHES + 1))
  if [ "$RELAUNCHES" -gt "$MAX_RELAUNCHES" ]; then
    note "relaunch: pi keeps dying; giving up after $MAX_RELAUNCHES relaunches. Resume line below."
    break
  fi

  # Exponential backoff, 15s doubling to a 10-minute ceiling. The common
  # killer here is a rate-limit window — pi's own in-session retries (3, over
  # ~14s) have already failed by the time we get here, so relaunching hot
  # would just spend the budget probing the same wall. Eight attempts on this
  # curve rides out ~40 minutes of continuous refusal.
  BACKOFF=$((15 * (1 << (RELAUNCHES - 1))))
  [ "$BACKOFF" -gt 600 ] && BACKOFF=600
  note "pi exited (code $PI_EXIT) with the run unfinished — relaunching ($RELAUNCHES/$MAX_RELAUNCHES) in ${BACKOFF}s"
  sleep "$BACKOFF"
  PROMPT="$(solver_prompt)$(resume_note)$METER_NOTE"
done
