#!/bin/bash
#
# TypeScript Formatting Hook for Claude Code
#
# Auto-formats TypeScript/JavaScript files after Write/Edit operations using
# Prettier, run from the monorepo root. No-ops cleanly until the workspace is
# scaffolded (root package.json + node_modules present).
#
# Exit codes:
#   0 = Success (file formatted, or nothing to do)
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
    npx prettier --write "$FILE_PATH" 2>/dev/null || true
fi

exit 0
