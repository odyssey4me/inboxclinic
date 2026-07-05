#!/bin/bash
#
# TypeScript Type Checking Hook for Claude Code
#
# Runs `tsc --noEmit` from the monorepo root after Write/Edit of a TS/JS file and
# surfaces type errors as warnings (never blocks). No-ops cleanly until the
# workspace is scaffolded (root package.json + node_modules present).
#
# Exit codes:
#   0 = Always (warnings go to stderr; operations are never blocked)
#

set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

[[ -z "$FILE_PATH" ]] && exit 0
[[ ! "$FILE_PATH" =~ \.(ts|tsx|js|jsx|mjs|cjs)$ ]] && exit 0
[[ ! -f "$FILE_PATH" ]] && exit 0

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"

# No workspace yet (or no deps installed) → nothing to do.
[[ -z "$REPO_ROOT" || ! -f "$REPO_ROOT/package.json" || ! -d "$REPO_ROOT/node_modules" ]] && exit 0

cd "$REPO_ROOT"
if command -v npx &> /dev/null; then
    TSC_OUTPUT=$(npx tsc --noEmit 2>&1) || true
    if echo "$TSC_OUTPUT" | grep -q "error TS"; then
        echo "" >&2
        echo "⚠️  TYPE ERRORS detected:" >&2
        echo "$TSC_OUTPUT" | grep "error TS" | head -10 >&2
        ERROR_COUNT=$(echo "$TSC_OUTPUT" | grep -c "error TS" || echo "0")
        [[ "$ERROR_COUNT" -gt 10 ]] && echo "... and $((ERROR_COUNT - 10)) more errors" >&2
        echo "" >&2
    fi
fi

exit 0
