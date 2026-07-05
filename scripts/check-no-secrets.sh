#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Zero-secrets check
# -----------------------------------------------------------------------------
# Inbox Clinic ships NO secrets by construction — the OAuth client is a public
# PKCE client, and nothing secret lives in the repo or the running client
# (architecture.md §7; docs/design-deployment.md). This script fails CI if
# anything resembling a credential is committed.
#
# See docs/design-deployment.md (CI pipeline) and .github/workflows/ci.yml.
#
# Usage:
#   ./scripts/check-no-secrets.sh
# -----------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/.."

# Patterns that must never appear in the tree. Kept narrow to avoid false
# positives (e.g. "client_secret" with an underscore, not the prose "client secret").
patterns=(
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'  # PEM private keys
  'client_secret'                       # OAuth client secret (we ship none)
  'aws_secret_access_key'               # AWS keys
  'xox[baprs]-[A-Za-z0-9-]+'            # Slack tokens
  'ghp_[A-Za-z0-9]{36}'                 # GitHub personal access tokens
  'AIza[0-9A-Za-z_-]{35}'               # Google API keys
)

joined="$(
  IFS='|'
  echo "${patterns[*]}"
)"

matches="$(
  grep -RInE --binary-files=without-match \
    --exclude-dir=.git \
    --exclude-dir=node_modules \
    --exclude-dir=dist \
    --exclude=package-lock.json \
    --exclude=check-no-secrets.sh \
    -e "$joined" . || true
)"

if [[ -n "$matches" ]]; then
  echo "❌ Potential secret(s) detected — Inbox Clinic must ship none:"
  echo "$matches"
  exit 1
fi

echo "✅ Zero-secrets check passed."
