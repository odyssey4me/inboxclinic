# Handle Blockers

This document defines how to handle issues and blockers during milestone execution, following CLAUDE.md guidance.

## Core Principle

**NEVER silently work around problems.** Always inform the user and present options.

## Blocker Categories

### 1. Architecture Changes Required

**Situation:** Implementation reveals that architecture.md needs modification.

**Response:**
```markdown
## Architecture Change Required

**What I Found:**
[Description of the issue]

**Architecture Reference:**
[Quote relevant section from architecture.md]

**Proposed Change:**
[What would need to change]

**Impact:**
- [Affected components]
- [Affected milestones]
- [Affected design docs]

**Options:**
1. **Pause and update architecture** - I can help draft the changes, but you'll need to approve
2. **Proceed with workaround** - [Describe temporary approach and technical debt]
3. **Skip this feature** - Continue with other phase work

Which approach would you prefer?
```

**CRITICAL:** Do NOT modify architecture.md without explicit user approval.

### 2. Design Doc Changes Required

**Situation:** Design doc is incomplete or incorrect for the implementation.

**Response:**
```markdown
## Design Doc Update Needed

**Document:** `docs/design-[name].md`

**Issue:**
[What's missing or incorrect]

**Proposed Update:**
[Specific change needed]

**Options:**
1. **Update design doc first** - I'll propose changes for your approval
2. **Proceed with assumption** - Document the assumption, verify later
3. **Ask clarifying question** - [Specific question to resolve ambiguity]

Which approach would you prefer?
```

### 3. External Dependencies Unavailable

**Situation:** Cluster access, credentials, APIs, or services needed but unavailable.

**Response:**
```markdown
## External Dependency Required

**What's Needed:**
[Credential, access, service]

**Why:**
[What phase task requires this]

**Options:**
1. **You provide/fix it** - [Specific steps for user to take]
2. **Skip dependent tasks** - Continue with [list of tasks that can proceed]
3. **Mock/stub for now** - [Describe what would be mocked and cleanup needed]

What would you like to do?
```

### 4. Tests Failing

**Situation:** Existing tests break, or new tests don't pass.

**Response:**
```markdown
## Test Failure

**Failing Tests:**
```
[Test output]
```

**Likely Cause:**
[Analysis of why tests fail]

**Options:**
1. **Fix the implementation** - [Describe needed fix]
2. **Update the tests** - [If tests are wrong/outdated]
3. **Investigate further** - [If cause unclear]
4. **Skip for now** - Mark as known issue, continue (not recommended)

Which approach would you prefer?
```

### 5. Ambiguous Requirements

**Situation:** Multiple valid interpretations of what to build.

**Response:**
```markdown
## Clarification Needed

**Question:**
[Specific question about requirements]

**Context:**
[Why this matters for the implementation]

**Options:**
A. [First interpretation] - [Pros/cons]
B. [Second interpretation] - [Pros/cons]
C. [Something else you have in mind]

Which approach should I take?
```

### 6. Google API Quota / Rate Limits

**Situation:** The Gmail/People API returns `429` or a quota error during a scan or
enforcement run (client talks directly to Google — there is no backend quota).

**Response:**
```markdown
## Google API Rate Limit / Quota

**Issue:**
[Error message or constraint hit, e.g. 429]

**Cause:**
[Why this is happening - large scan window, burst of filter writes, per-user limit]

**Options:**
1. **Back off / throttle** - [Implementation approach: slow or pause requests]
2. **Reduce the scan window** - [Trade-offs: fewer days of metadata]
3. **Raise the project quota** - [Steps for user in the Google Cloud console]
4. **Wait and retry** - [If transient]

What would you like to do?
```

## Escalation Triggers

**Stop immediately and ask the user** when:

1. **Security-sensitive decisions** - OAuth scopes, token handling, access control
2. **Privacy boundaries** - Anything that would send user data off-device
3. **Data migrations** - Changes affecting the on-device store (Dexie schema/version)
4. **Breaking changes** - Even in alpha, confirm intentional
5. **Unfamiliar territory** - Technology or pattern you're uncertain about

## Recovery Patterns

### After User Intervention

When user fixes something:
1. Verify the fix worked
2. Resume from where blocked
3. Update todo list with progress
4. Continue phase execution

### After Workaround Decision

When proceeding with workaround:
1. Document the workaround clearly (code comment or commit message)
2. Note technical debt created
3. Add follow-up item to address properly later
4. Continue with awareness of limitation

### After Skip Decision

When skipping blocked work:
1. Mark todo item as skipped with reason
2. Continue with remaining phase work
3. Include skipped items in phase completion report
4. Ensure roadmap reflects incomplete exit criteria

## Documenting Blockers

For blockers that will persist across conversations:

1. **Add to phase plan** - "Known issue: [description]"
2. **Commit message** - Note limitations in commit
3. **Code comments** - Only if truly necessary for context
4. **Roadmap** - Update exit criteria status if affected

## Example: Full Blocker Flow

```markdown
User: Continue with Phase 3

Claude: Let me re-read context documents and continue Phase 3.

[Reads CLAUDE.md, ROADMAP.md, phase plan]

I'm continuing with the trust-scoring implementation in packages/core. Let me
check the current state...

[Attempts to run tests]

## Test Failure

The scoring tests are failing because the fixture builder doesn't yet expose the
fields the v1 weighting needs.

**Error:**
```
TypeError: Cannot read properties of undefined (reading 'replyCount')
```

**Options:**
1. **Extend the builder** - Add the missing fields to senderBuilder and retry
2. **Adjust the test** - If the test assumed a field the schema doesn't define
3. **Investigate further** - Re-check design-trust-decisions.md for the expected inputs

Which approach would you prefer?

User: Extend the builder

Claude: I'll add the missing fields to senderBuilder per the Section 5 schema and
re-run the core tests...

[Updates the builder, retries tests successfully, continues phase work]
```

## Notes

- Always provide context for why something failed
- Present 2-4 options (not too many, not too few)
- Include a recommendation when you have one
- Be specific about what user action would help
- Track blocker resolution in todo list
