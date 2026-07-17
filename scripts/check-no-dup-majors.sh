#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# -----------------------------------------------------------------------------
# No duplicate major versions
# -----------------------------------------------------------------------------
# Fails if a critical dependency resolves to more than one MAJOR version in the
# installed tree. This catches "works-but-messy" upgrades where a bump (e.g. vite)
# leaves an older major behind because a peer (e.g. vitest) still pins it — the
# exact gap that a peer-strictness check does NOT flag (it's duplication, not a
# peer violation).
#
# See docs/design-deployment.md (CI pipeline) and .github/workflows/ci.yml.
#
# Usage:
#   ./scripts/check-no-dup-majors.sh
# -----------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

# Packages where two majors in one tree signals an incoherent upgrade.
critical=(vite vitest react react-dom)

fail=0
for pkg in "${critical[@]}"; do
  majors="$(
    npm ls "$pkg" --all 2>/dev/null \
      | grep -oE "[[:space:]]${pkg}@[0-9]+" \
      | grep -oE '[0-9]+$' \
      | sort -u
  )"
  n="$(printf '%s\n' "$majors" | grep -c . || true)"
  if [ "${n:-0}" -gt 1 ]; then
    echo "❌ $pkg has multiple major versions installed: $(echo "$majors" | tr '\n' ' ')"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "Reconcile the ecosystem so each critical package has a single major (see the"
  echo "Vite/Vitest Renovate group and 'npm dedupe' / 'npm why <pkg>')."
  exit 1
fi
echo "✅ No duplicate major versions among: ${critical[*]}"
