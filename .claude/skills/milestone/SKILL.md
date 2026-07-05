---
name: milestone
description: Plans and executes the next roadmap milestone. Use when the user wants to start a new milestone, asks "what's next", mentions "milestone", or wants to plan implementation work.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash, EnterPlanMode, AskUserQuestion, TodoWrite
---

# Milestone Planning Skill

This skill helps plan and execute roadmap milestones by breaking them into phases that fit within a single context window.

## When This Skill Applies

Use this skill when:
- User asks "what's next?" or "what should we work on?"
- User wants to start a new milestone
- User mentions "milestone" or "roadmap"
- User wants to plan implementation work
- User asks to continue work on a milestone in progress

## CRITICAL: In-Repo Plan File (Gitignored)

**Milestone plans are stored at `.claude/plans/current-milestone.md`** (gitignored). This ensures:
- Plans persist across conversations on the same machine
- Plans don't clutter git history with ephemeral planning artifacts
- Plans are cleaned up when milestones complete

### Plan File Lifecycle

1. **Create**: When starting a new milestone, create `.claude/plans/current-milestone.md`
2. **Update**: Mark phases complete as work progresses
3. **Delete**: When milestone is complete and user confirms, delete the plan file

### Directory Structure

```
.claude/plans/                   # Gitignored directory
└── current-milestone.md         # Active milestone plan (only one at a time)
```

**Note:** The `.claude/plans/` directory is gitignored. Only one milestone plan should exist at a time.

## CRITICAL: Context Preservation

**At the start of EVERY conversation or phase, read these documents:**

1. `CLAUDE.md` - Development principles, tool usage, failure handling
2. `docs/ROADMAP.md` - Milestone status, exit criteria, dependencies
3. `.claude/plans/current-milestone.md` - Current milestone plan (if exists)
4. Relevant design docs for the current milestone

This ensures guidance survives context compaction. The skill documents reference
CLAUDE.md extensively, but re-reading the source ensures nothing is lost.

## Core Principles

### 1. Plan Mode First

**Always use plan mode** before implementing anything. This ensures:
- User approval before significant work begins
- Clear phases that can span multiple conversations
- Documented decisions that survive context resets

### 2. Context Window Phases

Each phase MUST be:
- **Completable in one conversation** (~100k tokens of context)
- **Independently testable** - can verify success before next phase
- **Committable** - results in a meaningful git commit
- **Documented** - updates roadmap progress on completion

### 3. Human Intervention Points (per CLAUDE.md)

**STOP and ask the user** when:
- Architecture changes are needed (modify architecture.md)
- Design doc changes are needed (modify docs/design-*.md)
- Ambiguous requirements need clarification
- Multiple valid approaches exist
- External dependencies block progress
- Any failure occurs that can't be trivially resolved

## Available Workflows

### Identify Next Milestone

See [identify-next.md](identify-next.md) for the process to determine what milestone to work on.

### Plan Milestone Phases

See [plan-phases.md](plan-phases.md) for breaking a milestone into deliverable phases.

### Execute Phase

See [execute-phase.md](execute-phase.md) for completing a single phase.

### Handle Blockers

See [handle-blockers.md](handle-blockers.md) for the process when issues arise.

## Quick Reference

### Starting a New Milestone

1. Read `docs/ROADMAP.md` to identify next incomplete milestone
2. Read required design docs for that milestone
3. Enter plan mode and create phase breakdown
4. Get user approval
5. Begin Phase 1

### Continuing a Milestone

1. Read `.claude/plans/current-milestone.md` to see current phase progress
2. Read `docs/ROADMAP.md` to see overall milestone status
3. Identify which phase was last completed
4. Review any blockers or open items
5. Continue with next phase (or re-plan if needed)

### Completing a Milestone

1. Verify all exit criteria from roadmap are met
2. Update `docs/ROADMAP.md` to mark milestone complete
3. Commit the roadmap update
4. **Ask user to confirm milestone is complete**
5. **Delete `.claude/plans/current-milestone.md`** (cleanup)
6. Identify next milestone (but don't start without user request)

**IMPORTANT:** Only delete the plan file after explicit user confirmation that the milestone is complete. This prevents accidental loss of planning context.

## Key References

- **CLAUDE.md:** [CLAUDE.md](../../../CLAUDE.md) - **READ FIRST, EVERY TIME**
- **Roadmap:** [docs/ROADMAP.md](../../../docs/ROADMAP.md)
- **Architecture:** [docs/architecture.md](../../../docs/architecture.md)
- **Design docs:** `docs/design-*.md`

## CLAUDE.md Quick Reference (for context-limited situations)

These are the key CLAUDE.md principles. When in doubt, re-read the full file.

### Handling Failures and Blockers
- **NEVER silently work around problems** - Always inform the user
- **Present options** - Give choices rather than deciding autonomously
- **Ask for intervention** - If user can fix something, ask them to try
- **Explain failures** - Provide context about what went wrong

### Git Workflow Rules
- **Never push unless explicitly asked**
- **One problem per commit**
- **Meaningful commit messages** - What and why, not just how
- **Verify before committing** - Run tests first

### Tool Usage
| Task | Use (Native Tool) | NOT (Bash) |
|------|-------------------|------------|
| Read files | `Read` tool | `cat`, `head`, `tail` |
| Search content | `Grep` tool | `grep`, `rg` |
| Find files | `Glob` tool | `find`, `ls` |
| Edit files | `Edit` tool | `sed`, `awk` |
| Create files | `Write` tool | `echo >`, `cat >` |
| Explore codebase | `Agent` (Explore subagent) | Multiple grep/find |

### Code Standards
- No over-engineering - only make requested changes
- No dead code - delete rather than comment out
- No backwards compatibility hacks (alpha phase)
- Scripts must be Bash (.sh), not PowerShell

### Documentation Hierarchy
1. `architecture.md` - Authoritative specification (never modify without approval)
2. Design docs - Implementation interfaces
3. `ROADMAP.md` - Implementation order

## Status Tracking

Progress is tracked in `docs/ROADMAP.md`:
- Exit criteria checkboxes show granular progress
- "COMPLETE" suffix indicates finished milestones
- Phase progress can be noted in commit messages

## Example Phase Breakdown

For M1 (Auth & inbox scan) — illustrative only; reflect the real milestone in
`docs/ROADMAP.md`:

| Phase | Deliverable | Commits |
|-------|-------------|---------|
| 1 | Design doc review & approval (design-gmail-integration.md, design-local-store-schema.md) | 1-2 |
| 2 | Browser PKCE OAuth flow (`packages/core` auth port + `apps/web` sign-in) | 1-2 |
| 3 | Bounded metadata scan + sender/domain extraction (`packages/core`) | 1-2 |
| 4 | Dexie local store (profile, senders, domains) | 1-2 |
| 5 | Wire scan results into the store + sender-list view | 1-2 |
| 6 | **Validation & Testing** | 1-2 |

Each phase is one conversation, one testable unit, one or two commits.

## Validation Phase (Required)

**Every milestone MUST include a validation phase as the final phase.** This ensures all code works before marking the milestone complete.

The validation phase includes:
1. **Unit Tests** - Vitest passes with ≥80% coverage on `packages/core` logic
2. **Component/integration Tests** - `apps/web` tests pass against the mocked Gmail boundary and in-memory IndexedDB
3. **Build** - `vite build` produces a valid (installable) PWA
4. **Lint & Type Check** - ESLint + Prettier + `tsc --noEmit` pass
5. **Coverage Validation** - `packages/core` coverage stays ≥80%

See the current plan file for detailed validation checklists. See
[docs/design-testing.md](../../../docs/design-testing.md) for the two-tier test model.

### Coverage Validation Checklist

Before concluding any phase that adds or changes `packages/core` logic:

```bash
# Run the core tests with coverage (from packages/core)
vitest run --coverage
```

**Coverage requirements:**
- `packages/core` coverage ≥80% (lines/branches/functions/statements) — the blocking gate
- New core logic has test coverage
- All coverage exclusions carry a `// RATIONALE: <explanation>` (e.g. `/* v8 ignore next */`)

**If coverage drops:**
1. Add tests for uncovered code paths
2. For legitimate exclusions, use: `/* v8 ignore next */ // RATIONALE: <explanation>`
3. Document any exceptions in the code with clear rationale

**Valid rationale examples:**
- `/* v8 ignore next */ // RATIONALE: defensive branch unreachable per the type system`
- `/* v8 ignore next */ // RATIONALE: error path requires a real Google API outage`
