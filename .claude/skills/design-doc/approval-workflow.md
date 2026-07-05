# Design Document Approval Workflow

This document defines the approval process for design documents.

## Prerequisites

Before approving:
1. Document must have been reviewed (use review-checklist.md)
2. All blocking issues from review must be resolved
3. Document must not have unresolved Open Questions (or they're explicitly deferred)

## Approval Process

### Step 1: Verify Review Status

Check that:
- A review was performed (recently or in this session)
- No blocking issues remain
- Open Questions section says "None" or lists only deferred items

If review wasn't done, run the review workflow first.

### Step 2: Update Frontmatter

Edit the design document's frontmatter to update status:

**Before:**
```markdown
> **Status:** Draft
```

**After:**
```markdown
> **Status:** Approved
>
> **Last Updated:** YYYY-MM-DD
```

Use today's date for Last Updated.

### Step 3: Add Changelog Entry

Add or update the changelog at the bottom of the document:

**Format:**
```markdown
---

**Changelog:**

| Date | Change | Author |
|------|--------|--------|
| YYYY-MM-DD | Approved: [brief summary of what was approved/changed] | Claude |
| [previous entries...] |
```

The summary should note:
- Key decisions that were finalized
- Any changes made during review
- Why the document is now ready for use

### Step 4: Update docs/README.md Index

Find the design document in the index table and update its status:

**Before:**
```markdown
| [design-filename.md](design-filename.md) | Draft | Description | Arch Refs |
```

**After:**
```markdown
| [design-filename.md](design-filename.md) | Approved | Description | Arch Refs |
```

### Step 5: Create Commit

Create a commit with the approval:

```bash
git add docs/design-[filename].md docs/README.md
git commit -m "docs: approve [filename].md design document

[One sentence summary of what this design doc covers]"
```

## Approval Checklist

Before committing, verify:

- [ ] Frontmatter status is "Approved"
- [ ] Last Updated date is today
- [ ] Changelog has approval entry
- [ ] docs/README.md index updated
- [ ] Commit message follows convention

## Post-Approval

After approval:
- The design doc is now the authoritative source for its topic
- Changes to approved docs require discussion
- Implementation can proceed using the approved interfaces

## Rollback

If approval was premature:
1. Revert the commit
2. Re-review the document
3. Address issues before re-approving

## Notes

- Only approve documents that are actually ready
- If in doubt, ask the user for confirmation
- The changelog provides audit trail for approvals
- Keep commit messages concise but descriptive
