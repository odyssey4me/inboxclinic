# Documentation Index

All documentation for **Inbox Clinic** — a privacy-first, **client-only,
local-first Gmail management PWA** (solo-maintained, open-source). See the
scope/decision trail in [descope-plan.md](descope-plan.md).

## Documentation Principles

1. **Reference, Don't Repeat** — link rather than duplicate.
2. **Keep It DRY** — one authoritative location per fact.
3. **Design over Implementation** — capture *what* and *why*, not line-by-line *how*.

---

## Documentation Hierarchy

| Document | Audience | Purpose |
|----------|----------|---------|
| [architecture.md](architecture.md) | Architects, developers | **Authoritative source of truth** for all system design |
| [ROADMAP.md](ROADMAP.md) | Developers | Build milestones, order, and per-milestone design-doc review |
| The design docs (`design-*.md`) | Developers | Implementation interfaces and conventions |
| [descope-plan.md](descope-plan.md) | Maintainer | The decisions and rationale behind the client-only rebuild |
| [../README.md](../README.md) | End users | Project overview, features, quick start |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Contributors | Dev setup, testing, PR process, vulnerability reporting |
| [../CLAUDE.md](../CLAUDE.md) | AI assistants | Claude Code behaviour rules and quick reference |

---

## Documentation Flow & Layer Purpose

Documentation is **layered by stability**. Each layer answers a different question and
changes at a different rate. Read top-down; resolve conflicts top-down.

```
Principles · constraints · stable interfaces      → architecture.md  (durable — changes rarely)
       │  implemented by
Technology choices · implementation · constants    → design-*.md      (movable — changes freely)
       │  sequenced by
Build order · milestones                           → ROADMAP.md       (when / in what order)
       │  realised as
Code                                               → the source tree
```

| Layer | Purpose | Owns | Avoids |
|-------|---------|------|--------|
| **architecture.md** | The durable *what & why* | Principles, constraints, stable interfaces/contracts, the domain model | Specific technologies, libraries, tunable constants — anything that changes easily (except noting a *forced* constraint) |
| **design-\*.md** | The movable *how* | Technology choices, the implementation of each architecture interface, schemas, algorithm constants, conventions | Re-stating architecture principles (link instead); literal source code |
| **ROADMAP.md** | The *when / in what order* | Milestones, sequence, per-milestone design-doc review | Design detail (links to design docs) |
| **descope-plan.md** | The decision trail | Why the current shape was chosen | Ongoing spec (one-time rationale) |
| **../README.md** | End-user overview | Features, quick start, licence | Internal design |
| **../CONTRIBUTING.md** | Contributor workflow | Setup, testing, PR/vulnerability process | Design specs |
| **../CLAUDE.md** | AI behaviour rules | Tool usage, git workflow | Duplicating any of the above (links instead) |

**Altitude rule (architecture ↔ design).** If a statement would change when we swap a
library, tune a number, or pick a different host, it belongs in a **design doc**. If it
would only change when the *product's principles or stable interfaces* change, it belongs
in **architecture.md**. *Example:* "scoring is a pure function of user, provider, and
(deferred) cross-user signals" is **architecture**; "the user-signal weight is 0.77 in v1"
is **design**.

**Conflict resolution:** architecture.md → design docs → ROADMAP.md (top-down;
architecture changes require explicit approval).

---

## Architecture Document

**[architecture.md](architecture.md)** is the master
specification. Its sections:

| Topic | Section |
|-------|---------|
| Vision & principles | 1 |
| Constraints | 2 |
| System model (client-only, conceptual) | 3 |
| Trust-decision model | 4 |
| Data & privacy boundaries | 5 |
| Core interfaces (ports) | 6 |
| Access, openness & funding | 7 |
| User settings & opt-in features | 8 |
| Deferred capabilities & seams | 9 |
| Glossary / changelog | Appendix A–B |

**Never modify architecture.md without explicit approval.**

---

## Roadmap

**[ROADMAP.md](ROADMAP.md)** defines the build path for the client-only PWA —
ordered milestones, deliverables, exit criteria, and which design docs to review
before each milestone.

---

## Design Documents

The design docs (`design-*.md`) bridge architecture and implementation: interfaces,
conventions, and contracts (not code). Each references the architecture sections it
implements. Use [design-_template.md](design-_template.md) for new docs.

### Index

| Document | Status | Description | Arch Refs |
|----------|--------|-------------|-----------|
| [design-gmail-integration.md](design-gmail-integration.md) | Draft | Browser PKCE OAuth, metadata scan + History sync, sender extraction, native-filter compilation; `GmailClient` port | 2, 3, 6 |
| [design-trust-decisions.md](design-trust-decisions.md) | Draft | Trust-prompt workflow, scoring & prioritisation interfaces (pure `packages/core`), deferred network seam | 4, 6, 9 |
| [design-local-store-schema.md](design-local-store-schema.md) | Draft | On-device IndexedDB (Dexie) stores, keys, indexes, repository interface, export/delete, versioning | 5, 6 |
| [design-frontend.md](design-frontend.md) | Draft | Vite + React + Tailwind PWA, local-first state, 4-phase decision UX, components | 3, 6, 7, 8 |
| [design-analytics.md](design-analytics.md) | Draft | On-device analytics: inbox health score, time-saved, breakdowns, achievements, opt-in local shareable snapshot | 5, 8 |
| [design-testing.md](design-testing.md) | Draft | Vitest two-tier tests, mocked Gmail boundary, fixtures, coverage gate | 4, 6 |
| [design-deployment.md](design-deployment.md) | Draft | Hosting, no-secrets build, access/testing-mode, Tally waitlist, Sponsors, licence | 2, 7 |

### Status meaning

| Status | Meaning |
|--------|---------|
| **Draft** | Initial design; safe to implement, expect refinement (project is Alpha). |
| **Approved** | Stable; changes require discussion. |

### Using design documents

- Read on-demand before implementing a feature that touches the topic.
- They hold **interfaces and conventions**, not code, and link to architecture.md.
- Changes are **major changes** (may affect interfaces/data) — propose before implementing.

---

## Change Management

- **Architecture changes** require explicit approval, a rationale, and updates to
  affected design docs/code.
- **Design-doc changes** are major changes (interfaces/data/contracts); discuss
  first, update affected code alongside, and note breaking changes (Alpha allows them).

## Quick Reference

| I need to… | Read this |
|------------|-----------|
| Know what to build next | [ROADMAP.md](ROADMAP.md) |
| Understand the system | [architecture.md](architecture.md) |
| Implement a feature | The relevant design doc (`design-*.md`) + architecture sections |
| Understand why it's client-only | [descope-plan.md](descope-plan.md) |
| Set up development | [../CONTRIBUTING.md](../CONTRIBUTING.md) |
| Orient Claude Code | [../CLAUDE.md](../CLAUDE.md) |
