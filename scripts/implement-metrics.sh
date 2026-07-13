#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Implement-loop metrics report
# -----------------------------------------------------------------------------
# How many rounds (agent turns) the "Implement approved issue (Claude)" runs
# typically take, plus how often they hit the turn limit — a read on the loop's
# efficiency/effectiveness. Scrapes the `IMPLEMENT_METRICS` line each run emits
# (see the "Record run metrics" step in the workflow below).
#
# See .github/workflows/claude-issue-implement.yml.
# NOTE: downloads each run's log, so it is slow; keep the run-limit modest. Only
# runs created after the metrics step shipped carry the line.
#
# Usage:
#   ./scripts/implement-metrics.sh [run-limit]   # default 25
# -----------------------------------------------------------------------------
set -euo pipefail

REPO="${REPO:-odyssey4me/inboxclinic}"
WF="Implement approved issue (Claude)"
LIMIT="${1:-25}"

mapfile -t ids < <(gh run list --repo "$REPO" --workflow "$WF" --limit "$LIMIT" \
  --json databaseId,conclusion \
  --jq '.[] | select(.conclusion=="success" or .conclusion=="failure") | .databaseId')

turns=(); subtypes=()
for id in "${ids[@]}"; do
  line=$(gh run view "$id" --repo "$REPO" --log 2>/dev/null | grep -m1 -o 'IMPLEMENT_METRICS .*' || true)
  [[ -z "$line" ]] && continue
  t=$(grep -oE 'turns=[0-9]+' <<<"$line" | cut -d= -f2 || true)
  st=$(grep -oE 'subtype=[^ ]+' <<<"$line" | cut -d= -f2 || true)
  [[ "$t" =~ ^[0-9]+$ ]] && turns+=("$t")
  [[ -n "$st" ]] && subtypes+=("$st")
done

n=${#turns[@]}
if (( n == 0 )); then
  echo "No IMPLEMENT_METRICS found in the last $LIMIT runs."
  echo "(Metrics begin with runs created after this feature shipped.)"
  exit 0
fi

mapfile -t sorted < <(printf '%s\n' "${turns[@]}" | sort -n)
min=${sorted[0]}; max=${sorted[n-1]}; mid=$(( n / 2 ))
if (( n % 2 )); then median=${sorted[mid]}; else median=$(( (sorted[mid-1] + sorted[mid]) / 2 )); fi
sum=0; for t in "${turns[@]}"; do sum=$(( sum + t )); done
mean=$(( sum / n ))
limit_hits=$(printf '%s\n' "${subtypes[@]:-}" | grep -c '^error_max_turns$' || true)

echo "Implement-loop rounds over last $n runs (of $LIMIT scanned):"
echo "  turns:  min=$min  median=$median  mean=$mean  max=$max"
echo "  hit-turn-limit: $limit_hits / $n"
