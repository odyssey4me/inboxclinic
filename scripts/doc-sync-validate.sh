#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# -----------------------------------------------------------------------------
# Documentation Sync Checker
# -----------------------------------------------------------------------------
# Validates that documentation changes are properly synchronized:
# 1. Design doc status changes must be reflected in docs/README.md
# 2. New/removed docs in docs/ must be reflected in docs/README.md index
# 3. Modified design docs and architecture.md must have changelog entries
# 4. Design docs must not reference code symbols deleted in the same change (#110)
#
# This script is used by the Claude Code doc-sync hook
# (.claude/hooks/doc-sync-hook.sh) after Markdown edits, and can also be run manually.
# (No git pre-commit hook installs it.)
#
# Usage:
#   ./scripts/doc-sync-validate.sh [--staged]
#
# Options:
#   --staged    Check only staged files (for pre-commit hook)
#               Without this flag, checks working tree changes
#
# Exit codes:
#   0 = All checks passed
#   1 = Sync issues detected (with details printed to stderr)
# -----------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors for output
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

# Parse arguments
CHECK_STAGED=false
if [[ "${1:-}" == "--staged" ]]; then
    CHECK_STAGED=true
fi

# Track errors
ERRORS=()

# -----------------------------------------------------------------------------
# Helper Functions
# -----------------------------------------------------------------------------

# Get the list of changed files (staged or working tree)
get_changed_files() {
    if [[ "$CHECK_STAGED" == "true" ]]; then
        git diff --cached --name-only --diff-filter=ACMR
    else
        git diff --name-only --diff-filter=ACMR HEAD 2>/dev/null || \
        git diff --name-only --diff-filter=ACMR
    fi
}

# Get the list of deleted files
get_deleted_files() {
    if [[ "$CHECK_STAGED" == "true" ]]; then
        git diff --cached --name-only --diff-filter=D
    else
        git diff --name-only --diff-filter=D HEAD 2>/dev/null || \
        git diff --name-only --diff-filter=D
    fi
}

# Extract status from a design doc (looks for "> **Status:** <status>")
extract_doc_status() {
    local file="$1"
    if [[ -f "$file" ]]; then
        grep -oP '>\s*\*\*Status:\*\*\s*\K\w+' "$file" 2>/dev/null | head -1 || echo ""
    else
        echo ""
    fi
}

# Extract status from README index for a given design doc
# Looks for table rows like: | [filename.md](design/filename.md) | Status | ...
extract_readme_status() {
    local doc_name="$1"
    local readme="$REPO_ROOT/docs/README.md"
    if [[ -f "$readme" ]]; then
        # Match table row containing the doc link and extract status column
        grep -P "\|\s*\[${doc_name}\]" "$readme" 2>/dev/null | \
            sed -E 's/.*\|\s*\[[^]]+\][^|]*\|\s*([^|]+)\|.*/\1/' | \
            tr -d ' ' | head -1 || echo ""
    else
        echo ""
    fi
}

# Check if a doc is listed in the README index
is_doc_in_readme() {
    local doc_path="$1"
    local doc_name
    doc_name=$(basename "$doc_path")
    local readme="$REPO_ROOT/docs/README.md"

    if [[ -f "$readme" ]]; then
        grep -qP "\[${doc_name}\]" "$readme"
    else
        return 1
    fi
}

# Check if README is in the changed files
is_readme_changed() {
    get_changed_files | grep -q "^docs/README.md$"
}

# -----------------------------------------------------------------------------
# Check 1: Design Doc Status Sync
# -----------------------------------------------------------------------------
# If a design doc's status changed, docs/README.md must also be changed
# and the status in README must match the doc's status

check_design_doc_status() {
    local changed_files
    changed_files=$(get_changed_files)

    # Find changed design docs (excluding template)
    local design_docs
    design_docs=$(echo "$changed_files" | grep "^docs/design-.*\.md$" | grep -v "_template.md" || true)

    if [[ -z "$design_docs" ]]; then
        return 0
    fi

    for doc_path in $design_docs; do
        local doc_name
        doc_name=$(basename "$doc_path")
        local full_path="$REPO_ROOT/$doc_path"

        # Get current status from the doc
        local doc_status
        doc_status=$(extract_doc_status "$full_path")

        if [[ -z "$doc_status" ]]; then
            # Doc doesn't have a status field, skip
            continue
        fi

        # Get status from README
        local readme_status
        readme_status=$(extract_readme_status "$doc_name")

        if [[ -z "$readme_status" ]]; then
            # Doc not in README index - will be caught by check 2
            continue
        fi

        # Compare statuses (case-insensitive)
        if [[ "${doc_status,,}" != "${readme_status,,}" ]]; then
            if ! is_readme_changed; then
                ERRORS+=("Status mismatch: $doc_name has status '$doc_status' but docs/README.md shows '$readme_status'. Update docs/README.md to match.")
            else
                # README is changed, verify the new status matches
                # Re-extract from staged/current README
                local new_readme_status
                new_readme_status=$(extract_readme_status "$doc_name")
                if [[ "${doc_status,,}" != "${new_readme_status,,}" ]]; then
                    ERRORS+=("Status mismatch: $doc_name has status '$doc_status' but docs/README.md shows '$new_readme_status'. Ensure they match.")
                fi
            fi
        fi
    done
}

# -----------------------------------------------------------------------------
# Check 2: New/Removed Docs Index Sync
# -----------------------------------------------------------------------------
# New docs in docs/design/ or docs/operations/ must be added to README index
# Removed docs must be removed from README index

check_doc_index_sync() {
    local changed_files deleted_files
    changed_files=$(get_changed_files)
    deleted_files=$(get_deleted_files)

    # Check for new design docs (excluding template)
    local new_design_docs
    new_design_docs=$(echo "$changed_files" | grep "^docs/design-.*\.md$" | grep -v "_template.md" || true)

    for doc_path in $new_design_docs; do
        # Check if this is a newly added file (not just modified)
        if [[ "$CHECK_STAGED" == "true" ]]; then
            local file_status
            file_status=$(git diff --cached --name-status | grep "$doc_path" | cut -f1 || echo "M")
            if [[ "$file_status" == "A" ]]; then
                # New file - must be in README
                if ! is_doc_in_readme "$doc_path"; then
                    if ! is_readme_changed; then
                        ERRORS+=("New design doc '$doc_path' must be added to docs/README.md index.")
                    fi
                fi
            fi
        fi
    done

    # Check for new operations docs
    local new_ops_docs
    new_ops_docs=$(echo "$changed_files" | grep "^docs/operations/.*\.md$" || true)

    for doc_path in $new_ops_docs; do
        if [[ "$CHECK_STAGED" == "true" ]]; then
            local file_status
            file_status=$(git diff --cached --name-status | grep "$doc_path" | cut -f1 || echo "M")
            if [[ "$file_status" == "A" ]]; then
                if ! is_doc_in_readme "$doc_path"; then
                    if ! is_readme_changed; then
                        ERRORS+=("New operations doc '$doc_path' must be added to docs/README.md index.")
                    fi
                fi
            fi
        fi
    done

    # Check for deleted docs that are still in README
    local deleted_design_docs
    deleted_design_docs=$(echo "$deleted_files" | grep "^docs/design-.*\.md$" | grep -v "_template.md" || true)

    for doc_path in $deleted_design_docs; do
        if is_doc_in_readme "$doc_path"; then
            if ! is_readme_changed; then
                ERRORS+=("Deleted design doc '$doc_path' must be removed from docs/README.md index.")
            fi
        fi
    done

    local deleted_ops_docs
    deleted_ops_docs=$(echo "$deleted_files" | grep "^docs/operations/.*\.md$" || true)

    for doc_path in $deleted_ops_docs; do
        if is_doc_in_readme "$doc_path"; then
            if ! is_readme_changed; then
                ERRORS+=("Deleted operations doc '$doc_path' must be removed from docs/README.md index.")
            fi
        fi
    done
}

# -----------------------------------------------------------------------------
# Check 3: Changelog Entry Validation
# -----------------------------------------------------------------------------
# Modified design docs and architecture.md should have updated changelog entries
# with today's date (warns but doesn't fail - reminder only)

check_changelog_entries() {
    local changed_files
    changed_files=$(get_changed_files)
    local today
    today=$(date +%Y-%m-%d)

    # Check design docs for changelog entries
    local design_docs
    design_docs=$(echo "$changed_files" | grep "^docs/design-.*\.md$" | grep -v "_template.md" || true)

    for doc_path in $design_docs; do
        local full_path="$REPO_ROOT/$doc_path"
        local doc_name
        doc_name=$(basename "$doc_path")

        if [[ -f "$full_path" ]]; then
            # Check if the file has a changelog section with today's date
            if grep -q "Changelog:" "$full_path" 2>/dev/null; then
                if ! grep -q "| $today |" "$full_path" 2>/dev/null; then
                    ERRORS+=("Missing changelog entry: $doc_name was modified but has no changelog entry for $today. Add a changelog entry describing your changes.")
                fi
            fi
        fi
    done

    # Check architecture.md for changelog entry
    if echo "$changed_files" | grep -q "^docs/architecture.md$"; then
        local arch_path="$REPO_ROOT/docs/architecture.md"
        if [[ -f "$arch_path" ]]; then
            # Architecture uses "| Version | Date |" format in Appendix F
            if ! grep -qP "\|\s*[\d.]+\s*\|\s*$today\s*\|" "$arch_path" 2>/dev/null; then
                ERRORS+=("Missing changelog entry: architecture.md was modified but has no changelog entry for $today in Appendix F. Add a version entry describing your changes.")
            fi
        fi
    fi
}

# -----------------------------------------------------------------------------
# Check 4: Doc ↔ code symbol drift (diff-aware, deletion-triggered) — #110
# -----------------------------------------------------------------------------
# When a change DELETES a code module whose PascalCase name (or path) is still
# referenced in a design doc, flag it — so a doc can't keep naming code that was
# removed (the #106 `DomainDetail` miss). Diff-aware against origin/main, so it only
# ever looks at symbols removed in THIS change: forward-looking/planned references
# (to code that never existed, or was removed in an earlier change) are untouched.

check_doc_symbol_drift() {
    # Base = the mainline. On `main` itself (merge-base == HEAD) this yields no
    # deletions and the check is a no-op. Skip gracefully if origin/main isn't present
    # (e.g. a shallow clone with no base) rather than erroring.
    local base
    base=$(git merge-base HEAD origin/main 2>/dev/null || true)
    [[ -z "$base" ]] && return 0

    # Code modules deleted since the base (committed or in the working tree), excluding tests.
    local deleted
    deleted=$(git diff --diff-filter=D --name-only "$base" -- apps packages 2>/dev/null \
        | grep -E '\.(ts|tsx)$' | grep -vE '\.(test|spec)\.' || true)
    [[ -z "$deleted" ]] && return 0

    local design_docs
    design_docs=$(ls "$REPO_ROOT"/docs/design-*.md 2>/dev/null | grep -v "_template.md" || true)
    [[ -z "$design_docs" ]] && return 0

    local file base_name symbol doc
    for file in $deleted; do
        base_name=$(basename "$file")
        symbol="${base_name%.*}"
        # Only PascalCase module names (components/classes) — skip index/generic files that
        # would match unrelated prose.
        [[ "$symbol" =~ ^[A-Z][A-Za-z0-9]+$ ]] || continue
        # Still referenced by backticked name or by path in a current design doc?
        for doc in $design_docs; do
            if grep -qF -e "\`${symbol}\`" -e "$file" -e "${file%.*}" "$doc" 2>/dev/null; then
                ERRORS+=("Doc/code drift: $(basename "$doc") still references \`${symbol}\` (from deleted ${file}). Update the doc — drop the reference, or reword so it doesn't name a since-removed symbol.")
            fi
        done
    done
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

cd "$REPO_ROOT"

# Run checks
check_design_doc_status
check_doc_index_sync
check_changelog_entries
check_doc_symbol_drift

# Report results
if [[ ${#ERRORS[@]} -gt 0 ]]; then
    echo -e "${RED}Documentation sync issues detected:${NC}" >&2
    echo "" >&2
    for error in "${ERRORS[@]}"; do
        echo -e "${YELLOW}  - $error${NC}" >&2
    done
    echo "" >&2
    echo "Please update docs/README.md to reflect these changes." >&2
    exit 1
fi

exit 0
