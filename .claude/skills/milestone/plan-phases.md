# Plan Milestone Phases

This document defines how to break a milestone into phases suitable for individual conversations.

## Prerequisites

Before planning:
1. Read `CLAUDE.md` - Development principles and failure handling (CRITICAL)
2. Read `docs/ROADMAP.md` - Milestone definition and exit criteria
3. Check if `.claude/plans/current-milestone.md` exists (resume existing plan if so)
4. Read required design docs for the milestone
5. Read relevant sections of `docs/architecture.md`

## Planning Process

### Step 1: Enter Plan Mode

**Always use `EnterPlanMode`** before creating a phase breakdown. This:
- Signals to the user that planning is happening
- Allows thorough exploration before committing to a plan
- Requires explicit user approval before implementation

### Step 2: Gather Context

Read in parallel:
- The milestone section in `docs/ROADMAP.md`
- Each required design doc for the milestone
- Relevant architecture.md sections
- Existing code that will be extended/modified

### Step 3: Identify Natural Boundaries

Look for natural phase boundaries:
- **Design doc review** - Always a separate phase (first)
- **Scaffold / tooling** - Package setup, ports, configs that enable later work
- **Core implementation** - The main logic (usually in `packages/core`)
- **UI wiring** - Connecting `packages/core` into `apps/web`
- **Validation & testing** - Always the final phase (required)

### Step 4: Size Each Phase

Each phase must be completable in ONE context window:
- **Roughly 100k tokens** of context available
- **Plan for ~50k tokens** of actual work (reading + writing)
- If uncertain, err on the side of smaller phases

**Phase size heuristics:**
- 1-3 new files: Single phase
- 4-6 new files: Consider splitting
- Major refactoring: Dedicated phase
- Design doc review: 1-2 docs per phase

### Step 5: Define Phase Deliverables

For each phase, specify:
1. **Goal** - One sentence describing the outcome
2. **Files** - What will be created/modified
3. **Tests** - How to verify success
4. **Commit** - What the commit message will say
5. **Dependencies** - What must exist before this phase

### Step 6: Write Plan Document

**Write the plan to `.claude/plans/current-milestone.md`** (gitignored).

Create the directory if needed: `mkdir -p .claude/plans`

Use this format:

```markdown
# Milestone [N]: [Name] - Phase Plan

## Overview
[1-2 sentences describing the milestone goal]

## Context Documents
Re-read at the start of each phase:
- `CLAUDE.md` - Development principles
- `docs/ROADMAP.md` - Exit criteria
- [List relevant design docs]
- [List relevant architecture sections]

## Phase Breakdown

### Phase 1: [Name]
**Goal:** [One sentence]
**Files:**
- Create: [list]
- Modify: [list]
**Verification:** [How to test]
**Commit:** `[conventional commit message]`

### Phase 2: [Name]
...

## Exit Criteria Mapping
| Exit Criterion | Phase |
|----------------|-------|
| [From roadmap] | [N] |
| ... | ... |

## Human Intervention Points
- [When/why to stop and ask]
- [Architecture changes needed]
- [Design decisions to confirm]

## Risks and Mitigations
- [Potential blocker] → [Mitigation]
```

### Step 7: Get User Approval

After writing the plan, use `ExitPlanMode` to present it for approval.

The user should see:
- How many phases there are
- What each phase accomplishes
- Where human decisions are needed
- What the total scope looks like

## Phase Design Guidelines

### Good Phase Characteristics

- **Single responsibility** - Does one coherent thing
- **Testable** - Can verify success independently
- **Reversible** - Can be reverted if needed
- **Documented** - Clear commit message explains what/why

### Phase Anti-patterns

- **Too large** - "Implement entire feature" - break it down
- **Too small** - "Add import statement" - combine with related work
- **Ambiguous** - "Do some refactoring" - specify what exactly
- **Dependent on unwritten code** - Order phases correctly

### Referencing Skill Guidelines

**CRITICAL:** Each phase MUST include an execution reference section that points to the skill's execution guidelines. This ensures the phase execution follows the established workflow.

Each phase should include:

```markdown
**Execution:** Follow [execute-phase.md](.claude/skills/milestone/execute-phase.md):
1. Read context documents (CLAUDE.md, design docs, architecture.md sections)
2. Create TodoWrite task list for this phase
3. Execute tasks using native tools (Read/Edit/Write, not cat/sed/echo)
4. Handle failures per CLAUDE.md (present options, don't silently work around)
5. Verify success criteria before committing
6. Commit with meaningful message
7. Update this plan file to mark phase complete
```

Additionally, note any phase-specific guidance:
- Relevant CLAUDE.md sections to re-read
- Tool usage requirements (native tools over bash)
- Failure handling approach

Example:
```markdown
### Phase 3: Trust scoring
**Goal:** Implement the pure scoring function in `packages/core`

**Execution:** Follow [execute-phase.md](.claude/skills/milestone/execute-phase.md)
- Re-read: CLAUDE.md git workflow, docs/design-trust-decisions.md
- Use native Read/Edit tools, not cat/sed
- If tests fail, present options to user (don't silently work around)
- No dead code - delete rather than comment out
```

## Example: M2 Phases

```markdown
# M2: Trust scoring & prompt generation - Phase Plan

## Context Documents
- `CLAUDE.md` - Development principles (re-read each phase)
- `docs/ROADMAP.md` - M2 section
- `docs/design-trust-decisions.md` - Scoring & prioritisation interfaces
- `docs/architecture.md` - Sections 4 (trust-decision model), 6 (core interfaces)

## Phase Breakdown

### Phase 1: Design Doc Review
**Goal:** Review and approve design-trust-decisions.md
**CLAUDE.md Guidance:** Use design-doc skill for reviews
**Files:**
- Modify: docs/design-trust-decisions.md (status update)
- Modify: docs/README.md (index update)
**Verification:** Status shows "Approved" in the doc
**Commit:** `docs: approve design-trust-decisions.md`

### Phase 2: Trust scoring
**Goal:** Implement the pure v1 scoring function in `packages/core`
**CLAUDE.md Guidance:** Logic is framework-agnostic; co-locate Vitest tests
**Files:**
- Create: packages/core/src/scoring/trustScore.ts
- Create: packages/core/src/scoring/trustScore.test.ts
**Verification:** `vitest run` passes; core coverage ≥80%
**Commit:** `feat(core): add v1 trust scoring`

...
```

## Validation Phase (Required)

**Every milestone MUST end with a validation phase.** This phase verifies all code works before marking the milestone complete.

The validation phase template:

```markdown
### Phase N: Validation & Testing

**Goal:** Verify all code works before marking milestone complete

**Validation Checklist:**

#### Unit Tests (`packages/core`)
- [ ] `vitest run` - all tests pass
- [ ] `packages/core` coverage ≥80% (lines/branches/functions/statements)
- [ ] All new core logic has test coverage

#### Component/Integration Tests (`apps/web`)
- [ ] `apps/web` tests pass against the mocked Gmail boundary + in-memory IndexedDB
- [ ] No real Google calls in any test

#### Build
- [ ] `vite build` succeeds (apps/web)
- [ ] Output is a valid, installable PWA

#### Code Quality
- [ ] ESLint passes
- [ ] Prettier shows no changes needed
- [ ] `tsc --noEmit` passes (TypeScript strict)

**Exit criteria:**
- All validation checks pass
- Ready to mark milestone complete
```

## Updating the Plan File

As phases complete, **update `.claude/plans/current-milestone.md`** to track progress:

1. Mark completed phases with `[x]` or `✓ COMPLETE`
2. Note any blockers or changes discovered
3. Update remaining phases if scope changed

This ensures the next conversation can pick up where you left off.

## Plan Cleanup

**After a milestone is complete and user confirms:**

1. Delete `.claude/plans/current-milestone.md`
2. This is done in the milestone completion workflow (see SKILL.md)

**Never delete the plan file until the user explicitly confirms the milestone is complete.**

## Notes

- Always start with design doc review phase if docs aren't approved
- Always end with validation phase before marking complete
- Milestones that touch Google APIs (auth/scan/enforcement) are tested against the
  mocked `GmailClient` boundary, never real Google services - note this
- Keep phases independent enough to resume after days/weeks
- The plan file is gitignored - it won't clutter commit history
