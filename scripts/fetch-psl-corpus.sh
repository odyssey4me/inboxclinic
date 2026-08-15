#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Fetch the live Public Suffix List as a replay corpus
# -----------------------------------------------------------------------------
# Downloads publicsuffix.org's list and writes it to `.local/psl.json` for
# `realSuffixes.analysis.test.ts` to replay through `registrableDomain` and
# friends (docs/design-testing.md Decision 9, #252).
#
# Why the PSL and not a top-domain ranking (Tranco, Umbrella, Majestic): the
# failure modes in eTLD+1 handling are in the *suffix* rules — wildcards
# (`*.ck`), exceptions (`!www.ck`), multi-label suffixes (`co.uk`) and the
# PRIVATE section (`github.io`) — not in the popularity of the names beneath
# them. The PSL is also the authority the app's own resolver embeds, so
# replaying the live list against the bundled snapshot additionally measures how
# far behind that snapshot has drifted.
#
# The list is a real-world dataset of real domains, so it is **never committed**:
# it lands in the gitignored `.local/`, and the spec that reads it is skipped
# unless it is present. Tests never reach the network — this script does, once,
# by hand.
#
# See docs/design-testing.md Decision 9 and CONTRIBUTING.md.
#
# Usage:
#   ./scripts/fetch-psl-corpus.sh              # writes .local/psl.json
#   ./scripts/fetch-psl-corpus.sh --out PATH   # writes elsewhere
# -----------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

PSL_URL="https://publicsuffix.org/list/public_suffix_list.dat"
OUT=".local/psl.json"
if [[ "${1:-}" == "--out" ]]; then
  OUT="${2:?--out needs a path}"
fi

mkdir -p "$(dirname "$OUT")"
RAW="$(mktemp)"
trap 'rm -f "$RAW"' EXIT

echo "fetching $PSL_URL"
curl -fsSL "$PSL_URL" -o "$RAW"

# Classify each rule as the PSL algorithm defines them, and record which section
# it came from — the app runs `allowPrivateDomains: true`, so the PRIVATE section
# is load-bearing rather than decoration (design-trust-decisions.md Decision 9).
PSL_RAW="$RAW" PSL_URL="$PSL_URL" node -e '
const fs = require("node:fs");
const lines = fs.readFileSync(process.env.PSL_RAW, "utf8").split("\n");
let section = "ICANN";
const rules = [];
for (const line of lines) {
  const text = line.trim();
  if (text.startsWith("// ===BEGIN PRIVATE DOMAINS===")) { section = "PRIVATE"; continue; }
  if (text.startsWith("// ===BEGIN ICANN DOMAINS===")) { section = "ICANN"; continue; }
  if (text === "" || text.startsWith("//")) continue;
  const kind = text.startsWith("!") ? "exception" : text.startsWith("*.") ? "wildcard" : "normal";
  rules.push({ rule: text, kind, section });
}
const out = { source: process.env.PSL_URL, fetchedRules: rules.length, rules };
process.stdout.write(JSON.stringify(out));
' > "$OUT"

count=$(jq -r '.fetchedRules' "$OUT")
echo "wrote $OUT — $count rules"
echo
echo "replay it:"
echo "  INBOXCLINIC_PSL_CORPUS=\$PWD/$OUT npx vitest run --root packages/core realSuffixes"
