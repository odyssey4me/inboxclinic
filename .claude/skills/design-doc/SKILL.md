---
name: design-doc
description: Reviews and approves design documents. Use when the user opens a design doc, mentions "review", "approve", or "design doc", or when working with the design docs (docs/design-*.md).
allowed-tools: Read, Grep, Glob, Edit, Bash
---

# Design Document Skill

This skill helps review and approve design documents according to project standards.

## When This Skill Applies

Use this skill when:
- User opens a design doc (`docs/design-*.md`)
- User mentions "review", "approve", or "design doc"
- User asks to check a design doc against architecture standards
- User wants to mark a design doc as approved

## Available Workflows

### Review Workflow

See [review-checklist.md](review-checklist.md) for the complete review process.

**Summary:** Review evaluates a design document against:
1. Compliance with design document standards (docs/README.md)
2. Architecture alignment (docs/architecture.md)
3. Completeness of required sections
4. Appropriate scope boundaries
5. Specific recommendations for improvement

### Approval Workflow

See [approval-workflow.md](approval-workflow.md) for the complete approval process.

**Summary:** Approval performs these steps:
1. Verify review criteria are met
2. Update frontmatter status from Draft/Review to Approved
3. Add changelog entry with approval date and summary
4. Update docs/README.md design document index
5. Create a commit recording the approval

## Key References

- **Design document standards:** [docs/README.md](../../../docs/README.md)
- **Architecture spec:** [docs/architecture.md](../../../docs/architecture.md)
- **Design doc template:** [docs/design-_template.md](../../../docs/design-_template.md)
- **Roadmap (milestone assignments):** [docs/ROADMAP.md](../../../docs/ROADMAP.md)

## Status Progression

| Status | Meaning |
|--------|---------|
| **Draft** | Initial design, may have open questions |
| **Review** | Under active review, may change |
| **Approved** | Stable design, changes require discussion |

## Quick Commands

When user asks to:
- **"review this design doc"** → Run review checklist
- **"approve this design doc"** → Run approval workflow
- **"what's the status of design docs?"** → Check docs/README.md index
