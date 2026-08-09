#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
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

# Patterns that must never appear in the tree. Matched case-insensitively (grep -i) so
# upper-cased env-var forms like CLIENT_SECRET / AWS_SECRET_ACCESS_KEY are caught too;
# kept narrow to avoid false positives (e.g. "client_secret" with an underscore, not the
# prose "client secret").
patterns=(
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'  # PEM private keys
  'aws_secret_access_key'               # AWS keys
  'xox[baprs]-[A-Za-z0-9-]+'            # Slack tokens
  'ghp_[A-Za-z0-9]{36}'                 # GitHub personal access tokens (classic)
  'github_pat_[A-Za-z0-9_]{20,}'        # GitHub personal access tokens (fine-grained)
  'AIza[0-9A-Za-z_-]{35}'               # Google API keys
)

# `client_secret` is checked separately, because one file must NAME the field without
# containing one: the QA probe (docs/design-testing.md Decision 9) reads a Desktop OAuth
# client from the gitignored `.local/` and posts that field during its token exchange. The
# exception is for this pattern in that one path only — every other pattern above still
# applies to it, and any actual value would have to live in `.local/`, which git never sees.
secret_pattern='client_secret'
secret_exception='scripts/qa-gmail-probe.py'

joined="$(
  IFS='|'
  echo "${patterns[*]}"
)"

# Scan what git would SHIP — tracked files plus new ones not yet added — rather than the
# working tree. Ignored paths are developer-local by definition and can never be committed:
# scanning them fails the gate on, for example, the QA probe's own OAuth client file in
# `.local/`, which is precisely where such a file is supposed to live.
file_list() {
  git ls-files --cached --others --exclude-standard -z |
    grep -zv -e '^package-lock\.json$' -e '^scripts/check-no-secrets\.sh$'
}

scan() {
  file_list | xargs -0 -r grep -InEi --binary-files=without-match -e "$1" -- || true
}

# Joined with an explicit newline: command substitution strips trailing ones, so appending
# directly would run the last line of one block into the first line of the next.
matches="$(
  scan "$joined"
  scan "$secret_pattern" | grep -v "^${secret_exception}:" || true
)"

if [[ -n "$matches" ]]; then
  echo "❌ Potential secret(s) detected — Inbox Clinic must ship none:"
  echo "$matches"
  exit 1
fi

echo "✅ Zero-secrets check passed."
