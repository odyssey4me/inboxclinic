# Identify Next Milestone

This document defines how to identify the next milestone to work on.

## Process

### Step 1: Read Current State

Read these files in parallel:
- `docs/ROADMAP.md` - Current milestone status
- `CLAUDE.md` - Development principles and tool usage (CRITICAL for context preservation)

### Step 2: Analyze Roadmap

Look for:
1. **First incomplete milestone** - Scan from M0 down (milestones are ordered M0–M8)
2. **Ordering** - Milestones are sequential; M0–M2 are largely independent of the UI and M3+ build on them. Confirm earlier milestones are complete before starting a later one
3. **Partial progress** - Check exit criteria / deliverables for the milestone

### Step 3: Verify Prerequisites

For the identified milestone:
1. Check that all prerequisite milestones are marked COMPLETE
2. Check that required design docs are listed
3. Note which design docs need approval before implementation

### Step 4: Report to User

Present:
```markdown
## Next Milestone: [Number] - [Name]

**Status:** [Not started / In progress]

**Prerequisites:**
- [x] Milestone X complete
- [x] Milestone Y complete

**Design Docs Required:**
- [ ] `doc1.md` - Status: Draft
- [ ] `doc2.md` - Status: Draft

**Estimated Phases:** [Number based on deliverable count]

Would you like me to:
1. Review and approve required design docs first?
2. Create a phase-by-phase plan for this milestone?
3. Something else?
```

## Decision Points

### If Earlier Milestones Are Largely UI-Independent

The roadmap notes that M0–M2 are largely independent of the UI (M3+ build the
experience on top). If the next milestone depends on logic that isn't built yet,
confirm the prerequisite is in place before starting.

Ask user:
> "M3 (Decision UI) builds on the scoring/prompt logic from M2. Should I confirm M2 is complete first, or focus elsewhere?"

### If Milestone Is Already In Progress

Look for:
- Partially checked exit criteria
- Recent commits mentioning the milestone
- Existing files/code for milestone deliverables

Report:
> "Milestone X appears to be in progress. [Summary of completed work]. Should I continue from where it left off?"

## Context Preservation

**CRITICAL:** At the start of each new conversation for milestone work:
1. Re-read `CLAUDE.md` for development principles
2. Re-read `docs/ROADMAP.md` for current state
3. Re-read relevant design docs for interfaces

This ensures guidance survives context compaction.

## Notes

- Don't start work until user confirms
- If unsure which milestone, ask
- Always verify dependencies before starting
