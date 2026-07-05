# Execute Phase

This document defines how to execute a single phase of milestone work.

## Prerequisites

**CRITICAL - Read these at the start of EVERY phase:**

1. `CLAUDE.md` - Development principles, tool usage, failure handling
2. `docs/ROADMAP.md` - Milestone definition, exit criteria, current state
3. `.claude/plans/current-milestone.md` - The phase plan (persists across conversations)
4. Relevant design docs for this phase
5. Relevant architecture.md sections

This ensures guidance survives context compaction across conversations.

**If `.claude/plans/current-milestone.md` doesn't exist**, the milestone hasn't been planned yet. Use the planning workflow first.

## Execution Process

### Step 1: Establish Context

At the start of a new conversation for phase work:

```
Read in parallel:
- CLAUDE.md
- docs/ROADMAP.md (milestone section)
- .claude/plans/current-milestone.md (the persistent plan file)
- Relevant design docs
```

### Step 2: Verify Phase Readiness

Check:
- [ ] Previous phase completed (if any)
- [ ] Required design docs are approved
- [ ] No blocking issues from previous work
- [ ] External dependencies available (cluster access, credentials, etc.)

If not ready:
> "Phase X cannot start because: [reason]. Would you like me to address this first?"

### Step 3: Create Todo List

Use `TodoWrite` to track phase tasks:

```
Phase N: [Name]
- [ ] [Specific task 1]
- [ ] [Specific task 2]
- [ ] [Verification step]
- [ ] [Commit]
```

### Step 4: Execute Tasks

Follow CLAUDE.md guidance throughout:

**Tool Usage:**
- Use native tools (Read, Edit, Write, Glob, Grep) for file operations
- Use Bash only for actual commands (git, the package manager, vitest, etc.)
- Use Task tool for exploration that needs multiple searches

**Code Standards:**
- TypeScript: Prettier + ESLint (auto-applied by hooks); `tsc --noEmit` strict
- No dead code - delete rather than comment
- No backwards compatibility hacks in alpha

**Testing:**
- Run tests after changes
- Verify against phase success criteria
- Check exit criteria progress

### Step 5: Handle Issues

When something fails or blocks progress, follow CLAUDE.md guidance:

1. **Do NOT silently work around the problem**
2. **Present options to the user:**
   - Try a workaround
   - Skip and continue
   - Wait for user to fix underlying issue
3. **Explain the failure** with context

See [handle-blockers.md](handle-blockers.md) for detailed guidance.

### Step 6: Verify Success

Before committing, verify:
- [ ] All phase tasks complete
- [ ] Tests pass (if applicable)
- [ ] No regressions introduced
- [ ] Code follows standards

### Step 7: Commit Results

Following CLAUDE.md git workflow:

1. **One problem per commit** - If phase has multiple distinct changes, consider multiple commits
2. **Meaningful commit message** - Describe what and why
3. **Don't push unless asked** - Only commit, don't push

```bash
git add [files]
git commit -m "$(cat <<'EOF'
type: brief description

Longer explanation if needed.
EOF
)"
```

### Step 8: Update Progress

After successful commit:

1. **Update `.claude/plans/current-milestone.md`** - Mark completed phase with `✓ COMPLETE`
2. **Update roadmap** if exit criteria were met
3. **Note any blockers** for next phase in the plan file
4. **Report to user** what was accomplished

## Phase Completion Report

At the end of each phase, report:

```markdown
## Phase [N] Complete: [Name]

**Accomplished:**
- [Bullet points of what was done]

**Commits:**
- `abc1234` - [commit message]

**Exit Criteria Progress:**
- [x] [Criterion met]
- [ ] [Criterion pending - Phase N+1]

**Blockers for Next Phase:**
- [Any issues discovered]

**Next Phase:** [N+1] - [Name]
Ready to continue? [Describe what's needed]
```

## CLAUDE.md Quick Reference

Keep these principles in mind during execution:

### Handling Failures
- Present options, don't decide autonomously
- Ask for intervention when user can help
- Explain context for failures

### Git Workflow
- Never push unless asked
- One problem per commit
- Verify before committing

### Code Quality
- No over-engineering
- Only make requested changes
- Delete unused code completely

### Tool Usage
| Task | Use |
|------|-----|
| Read files | `Read` tool |
| Search content | `Grep` tool |
| Find files | `Glob` tool |
| Edit files | `Edit` tool |
| Create files | `Write` tool |
| System commands | `Bash` tool |

## Notes

- Re-read context docs at start of each conversation
- The plan file (`.claude/plans/current-milestone.md`) is gitignored and persists across conversations
- TodoWrite helps track progress within a phase
- If phase is too large, split it mid-execution with user approval
- Document any learnings for future phases in the plan file
