#!/bin/bash
#
# Documentation Sync Check Hook for Claude Code
#
# This hook runs after Write/Edit operations on markdown files.
# It validates documentation sync and reminds Claude to fix issues.
#
# Uses the same validation logic as the git pre-commit hook
# (scripts/doc-sync-validate.sh) for consistency.
#
# Exit codes:
#   0 = Success (with optional JSON output for context)
#   2 = Block the action (used when validation fails)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Read JSON input from stdin
INPUT=$(cat)

# Extract the file path from the tool input
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# If no file path, exit silently
if [[ -z "$FILE_PATH" ]]; then
    exit 0
fi

# Only process markdown files
if [[ ! "$FILE_PATH" =~ \.(md|mdx)$ ]]; then
    exit 0
fi

# Check if this is a documentation file that triggers validation
IS_DESIGN_DOC=false
IS_OPS_DOC=false
IS_README=false

if [[ "$FILE_PATH" =~ docs/design-.*\.md$ ]] && [[ ! "$FILE_PATH" =~ _template\.md$ ]]; then
    IS_DESIGN_DOC=true
fi

if [[ "$FILE_PATH" =~ docs/operations/ ]]; then
    IS_OPS_DOC=true
fi

if [[ "$FILE_PATH" =~ docs/README\.md$ ]]; then
    IS_README=true
fi

# If not a doc that needs sync checking, provide general reminder and exit
if [[ "$IS_DESIGN_DOC" != "true" ]] && [[ "$IS_OPS_DOC" != "true" ]] && [[ "$IS_README" != "true" ]]; then
    # For architecture docs and other docs, just provide a reminder
    if [[ "$FILE_PATH" =~ docs/architecture\.md$ ]] || [[ "$FILE_PATH" =~ ^(README|CONTRIBUTING|CLAUDE)\.md$ ]] || [[ "$FILE_PATH" =~ /(README|CONTRIBUTING|CLAUDE)\.md$ ]]; then
        REMINDER="You modified: \`$FILE_PATH\`

Check if docs/README.md or other docs need updating to reflect this change."

        jq -n --arg reminder "$REMINDER" '{
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "additionalContext": $reminder
            }
        }'
    fi
    exit 0
fi

# For design docs, operations docs, or README changes, run validation
# Use working tree mode (not --staged) since we're checking after edits, not at commit time
cd "$REPO_ROOT"

# Capture validation output
VALIDATION_OUTPUT=""
VALIDATION_FAILED=false

if ! VALIDATION_OUTPUT=$("$REPO_ROOT/scripts/doc-sync-validate.sh" 2>&1); then
    VALIDATION_FAILED=true
fi

if [[ "$VALIDATION_FAILED" == "true" ]]; then
    # Validation failed - provide detailed error message
    # Clean up the output for JSON (escape special characters)
    CLEAN_OUTPUT=$(echo "$VALIDATION_OUTPUT" | sed 's/\x1b\[[0-9;]*m//g' | tr '\n' ' ' | sed 's/  */ /g')

    ERROR_MSG="Documentation sync validation failed after editing \`$FILE_PATH\`.

$CLEAN_OUTPUT

You must update docs/README.md to match the changes before committing:
- If you changed a design doc's Status, update the status in docs/README.md's Design Document Index
- If you added a new doc, add it to the appropriate table in docs/README.md
- If you removed a doc, remove it from docs/README.md"

    jq -n --arg error "$ERROR_MSG" '{
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": $error
        }
    }'
else
    # Validation passed - provide confirmation
    if [[ "$IS_DESIGN_DOC" == "true" ]]; then
        REMINDER="Design doc \`$FILE_PATH\` modified. Documentation sync check passed.

If you changed the Status field, verify docs/README.md reflects the new status."
    elif [[ "$IS_OPS_DOC" == "true" ]]; then
        REMINDER="Operations doc \`$FILE_PATH\` modified. Documentation sync check passed."
    else
        REMINDER="docs/README.md modified. Documentation sync check passed."
    fi

    jq -n --arg reminder "$REMINDER" '{
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": $reminder
        }
    }'
fi

exit 0
