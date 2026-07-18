#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Playwright image pin matches @playwright/test
# -----------------------------------------------------------------------------
# Fails if the Playwright container image tag in .github/workflows/ci.yml doesn't
# match the @playwright/test version in package.json. scripts/gate.sh derives the
# image from the npm version, so a drift would give CI and local runs different
# browsers (a subtle-flake risk). Renovate groups the two (renovate.json) so they
# bump together — this asserts the invariant instead of trusting the grouping (#107).
#
# See CONTRIBUTING.md (Checks) and .github/workflows/ci.yml.
#
# Usage:
#   ./scripts/check-playwright-image-pin.sh
# -----------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

PW="$(node -p "require('./package.json').devDependencies['@playwright/test'].replace(/[^0-9.]/g,'')")"
EXPECTED="mcr.microsoft.com/playwright:v${PW}-noble"

if ! grep -qF "$EXPECTED" .github/workflows/ci.yml; then
  echo "❌ .github/workflows/ci.yml is not pinned to the Playwright image for @playwright/test v${PW}"
  echo "   expected the e2e job's container to be: ${EXPECTED}"
  echo "   (bump them together — Renovate groups the npm package + image; see renovate.json)"
  exit 1
fi
echo "✅ ci.yml Playwright image matches @playwright/test v${PW} (${EXPECTED})"
