#!/usr/bin/env bash
#
# run-pixe-fleet.sh — run several models against pixe at once.
#
#   ./run-pixe-fleet.sh [shared flags] -- provider:model [provider:model ...]
#
#   ./run-pixe-fleet.sh --verified -- \
#       anthropic:claude-fable-5 anthropic:claude-opus-5 anthropic:claude-sonnet-5
#
# Everything before `--` is handed to every run-pixe.sh unchanged (--thinking,
# --verified, --api, --config). Everything after it is a provider:model spec.
# Each spec is its own registration, its own scratch workdir, its own
# leaderboard row — the runs share nothing but this terminal, where their
# output is interleaved under a coloured [model] prefix.
#
# This script adds no benchmark semantics on top of run-pixe.sh, and that is
# a promise, not an accident: a fleet run and a solo run must be
# indistinguishable to the server, or the fleet would be a config worth
# declaring. Ctrl-C stops everything; each run prints its own summary and
# resume line on the way down, so a killed fleet is N resumable runs, not one
# lost one.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

die() { printf 'run-pixe-fleet: %s\n' "$*" >&2; exit 1; }

SHARED=()
SPECS=()
seen_sep=0
for arg in "$@"; do
  if [ "$arg" = "--" ] && [ "$seen_sep" -eq 0 ]; then seen_sep=1; continue; fi
  if [ "$seen_sep" -eq 1 ]; then SPECS+=("$arg"); else SHARED+=("$arg"); fi
done

if [ "$seen_sep" -eq 0 ] || [ "${#SPECS[@]}" -lt 1 ]; then
  die "usage: ./run-pixe-fleet.sh [shared run-pixe.sh flags] -- provider:model [provider:model ...]"
fi

for spec in "${SPECS[@]}"; do
  case "$spec" in
    *:*) ;;
    *) die "'$spec' is not provider:model (e.g. anthropic:claude-opus-5)" ;;
  esac
done

# Flags that name a single run make no sense shared across several.
for flag in ${SHARED[@]+"${SHARED[@]}"}; do
  case "$flag" in
    --provider|--model|--resume|--workdir)
      die "$flag is per-run and cannot be shared across a fleet; resume or redirect a single run with run-pixe.sh itself" ;;
  esac
done

# One colour per run so the interleaved stream can be read at a glance.
# Skipped when stderr is not a terminal, so logs stay grep-clean.
COLORS=(36 33 35 32 34 31)

# A run's prefix label is its bare model name — unless the same model appears
# twice (same model on two providers), in which case every label carries its
# provider so the two streams stay tellable apart.
label_for() {
  local spec="$1" bare="${1#*:}" other
  bare="${bare##*/}"
  for other in "${SPECS[@]}"; do
    [ "$other" = "$spec" ] && continue
    local obare="${other#*:}"
    if [ "${obare##*/}" = "$bare" ]; then
      printf '%s %s' "${spec%%:*}" "$bare"
      return
    fi
  done
  printf '%s' "$bare"
}

PIDS=()
LABELS=()

i=0
for spec in "${SPECS[@]}"; do
  provider="${spec%%:*}"
  model="${spec#*:}"
  label="$(label_for "$spec")"

  if [ -t 2 ]; then
    color="${COLORS[$((i % ${#COLORS[@]}))]}"
    prefix="$(printf '\033[%sm[%s]\033[0m ' "$color" "$label")"
  else
    prefix="[$label] "
  fi

  (
    "$HERE/run-pixe.sh" --provider "$provider" --model "$model" \
      ${SHARED[@]+"${SHARED[@]}"} 2>&1 \
      | awk -v p="$prefix" '{ print p $0; fflush() }' >&2
  ) &
  PIDS+=($!)
  LABELS+=("$label")
  i=$((i + 1))

  # Stagger the launches a little so the preflight and registration notes of
  # one run are not shredded through another's.
  sleep 3
done

printf '\nrun-pixe-fleet: %d runs launched (%s). Ctrl-C stops them all.\n\n' \
  "${#PIDS[@]}" "$(printf '%s, ' "${LABELS[@]}" | sed 's/, $//')" >&2

# On Ctrl-C the children get SIGINT with us (same process group) and each
# run-pixe.sh prints its own summary; the trap only covers a bare kill of
# this script.
trap 'trap - INT TERM; kill ${PIDS[@]+"${PIDS[@]}"} 2>/dev/null || true' INT TERM

FAILED=0
for idx in "${!PIDS[@]}"; do
  if ! wait "${PIDS[$idx]}"; then
    FAILED=$((FAILED + 1))
  fi
done

if [ "$FAILED" -gt 0 ]; then
  printf '\nrun-pixe-fleet: done — %d of %d runs exited non-zero; their resume lines are above.\n' \
    "$FAILED" "${#PIDS[@]}" >&2
  exit 1
fi
printf '\nrun-pixe-fleet: done — all %d runs finished.\n' "${#PIDS[@]}" >&2
