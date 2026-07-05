# Design: [Topic Name]

> **Status:** Draft | Review | Approved
>
> **Last Updated:** YYYY-MM-DD

## Overview

Brief description of what this design document covers and why it exists. What problem does it solve? What consistency does it establish?

## Architecture Reference

This design implements the following sections of [architecture.md](architecture.md):

> **Keep It DRY:** Link to architecture.md sections rather than copying content. If architecture.md defines it, reference it here with a brief note on how this design extends or implements that specification.

| Section | Title | Relevance |
|---------|-------|-----------|
| X.Y | Section Name | How this design relates to that section |

## Design Decisions

### Decision 1: [Title]

**Context:** What situation or requirement led to this decision?

**Decision:** What was decided?

**Rationale:** Why was this chosen over alternatives?

**Alternatives Considered:**
- Alternative A: Why rejected
- Alternative B: Why rejected

### Decision 2: [Title]

...

## Interfaces

Define the contracts, schemas, or conventions that consumers must follow.

### [Interface Name]

```
[Schema, type definition, or contract specification]
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| ... | ... | ... | ... |

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VAR_NAME` | Yes/No | `value` | What it controls |

### Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `setting.name` | type | value | What it controls |

## Error Handling

### Error Types

| Error | Code | When | Recovery |
|-------|------|------|----------|
| ErrorName | CODE | When this occurs | How to handle |

### Error Responses

```json
{
  "example": "error response format"
}
```

## Examples

### Example 1: [Scenario]

```
[Code or configuration example]
```

### Example 2: [Scenario]

```
[Code or configuration example]
```

## Migration Notes

If this design changes existing behaviour, document migration steps here.

## Open Questions

- [ ] Question 1: What needs to be decided?
- [ ] Question 2: What needs clarification?

---

**Changelog:**

| Date | Change | Author |
|------|--------|--------|
| YYYY-MM-DD | Initial draft | Name |
