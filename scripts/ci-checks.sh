#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# The CI `build` job, as one command
# -----------------------------------------------------------------------------
# Runs exactly what .github/workflows/ci.yml's `build` job runs, in the same
# order — the guards, lint, typecheck, knip, tests with coverage, and the build.
#
# **This list lives here and nowhere else.** It used to exist twice: as steps in
# ci.yml and as the CHECKS string in scripts/gate.sh. A third, hand-typed subset
# is how `knip` got skipped before a push and took `ci-gate` red on main. CI, the
# pre-push hook, and gate.sh all call this file, so they cannot disagree about
# what "the checks" are.
#
# NOT included, deliberately:
#   * the `docs` job (./scripts/doc-sync-validate.sh) — a separate CI job, and
#     the pre-push hook runs it alongside this script;
#   * the `e2e` job — the full Playwright matrix needs the pinned container
#     (WebKit cannot launch on a Fedora host), which is what gate.sh is for.
#
# Output is wrapped in ::group:: markers under GitHub Actions, so a single step
# still reads as collapsible per-check sections in the Actions UI.
#
# See CONTRIBUTING.md § Checks and .github/workflows/ci.yml.
#
# Usage:
#   ./scripts/ci-checks.sh
# -----------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Collapsible sections in Actions; plain headings anywhere else.
in_actions() { [[ -n "${GITHUB_ACTIONS:-}" ]]; }

run_check() {
  local name="$1"
  shift
  if in_actions; then echo "::group::${name}"; else echo; echo "==> ${name}"; fi
  "$@"
  if in_actions; then echo "::endgroup::"; fi
}

run_check "Zero-secrets check" ./scripts/check-no-secrets.sh
run_check "No duplicate major versions" ./scripts/check-no-dup-majors.sh
run_check "Playwright image pin matches @playwright/test" ./scripts/check-playwright-image-pin.sh
run_check "Lint" npm run lint
run_check "Typecheck" npm run typecheck
run_check "Dead-code / orphaned-module check" npm run knip
run_check "Test & coverage" npm run test:coverage
run_check "Build" npm run build

echo
echo "ci-checks: build-job checks passed"
