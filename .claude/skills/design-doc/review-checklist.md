# Design Document Review Checklist

This document defines the review process for design documents.

## Prerequisites

Before reviewing, read:
1. `CLAUDE.md` - AI behavior rules and design doc guidelines
2. `docs/README.md` - Documentation structure and design doc requirements
3. `docs/architecture.md` - Sections referenced by the design doc

## Review Process

### Step 1: Identify the Document

Determine which design doc to review:
- Use the currently open file in the IDE if it's a design doc (`docs/design-*.md`)
- If ambiguous, ask the user which document to review
- Verify the file exists and is a design document (not `_template.md`)

### Step 2: Read Context Documents

Read in parallel:
- The design document itself
- `docs/README.md` (design document standards)
- Architecture sections referenced in the design doc's "Architecture Reference" table

### Step 3: Evaluate Compliance

Check against each criterion and note findings:

#### 3.1 Design Document Standards (docs/README.md)

| Criterion | Check |
|-----------|-------|
| Has Overview section | Describes what and why |
| Has Architecture Reference | Links to specific architecture.md sections |
| Has Design Decisions | Key choices with rationale |
| Has Interfaces | Contracts, schemas, conventions |
| Has Configuration | Environment variables, settings |
| Has Error Handling | How errors are reported |
| Has Examples | Concrete usage examples |
| Has Open Questions | Or explicitly states "None" |
| DRY principle | Links to architecture.md, doesn't copy |

#### 3.2 Architecture Alignment

| Criterion | Check |
|-----------|-------|
| References correct sections | Architecture Reference table is accurate |
| No conflicts | Design doesn't contradict architecture.md |
| Complete coverage | All relevant architecture requirements addressed |
| Extends appropriately | Any extensions are clearly marked as such |

#### 3.3 Completeness

| Criterion | Check |
|-----------|-------|
| No placeholders | No TODO, TBD, or placeholder text |
| Examples are concrete | Not abstract descriptions |
| Interfaces are specific | Types, formats, and contracts defined |
| Open questions resolved | Or explicitly documented for deferral |

#### 3.4 Scope Boundaries

| Criterion | Check |
|-----------|-------|
| Scope clearly defined | What's in and out is clear |
| Out-of-scope appropriate | Excluded items make sense |
| No scope creep | Doesn't duplicate other design docs |
| Single responsibility | Focuses on one cohesive topic |

### Step 4: Generate Report

Provide a structured assessment:

```markdown
## Design Document Review: [filename]

### Summary
[1-2 sentence overall assessment]

### Compliance with Standards
[Findings from 3.1]

### Architecture Alignment
[Findings from 3.2]

### Completeness
[Findings from 3.3]

### Scope Assessment
[Findings from 3.4]

### Recommendations
[Specific issues to address, ordered by priority]

### Verdict
[ ] Ready for approval
[ ] Needs minor revisions (list them)
[ ] Needs significant revisions (list them)
```

## Review Outcomes

| Outcome | Next Step |
|---------|-----------|
| Ready for approval | User can run approval workflow |
| Minor revisions | Fix issues, then re-review or approve |
| Significant revisions | Fix issues, then re-review |

## Notes

- Be specific about issues (quote problematic text, cite line numbers)
- Suggest concrete fixes, not just problems
- Reference architecture.md sections when citing conflicts
- Check the changelog for recent changes that might need review
