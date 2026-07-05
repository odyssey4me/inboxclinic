# CLAUDE.md - Development Guide for AI Assistants

This file provides quick orientation for Claude Code and other AI assistants.

It owns **AI behaviour rules, tool usage, and git workflow**. For everything else it
links out to the authoritative doc — see [docs/README.md](docs/README.md) for the full
documentation index, the layer purposes, and boundary rules. Do not duplicate content
from other docs here.

**Scoped context (progressive disclosure):** as the codebase is scaffolded, major
packages (`apps/web/`, `packages/core/`) may carry a short `CLAUDE.md` that Claude Code
loads automatically when you work in them, each linking to the relevant design docs.
Keep these lean and pointer-based; put authoritative detail in design docs, not in a
CLAUDE.md.

## Tool Usage Requirements (CRITICAL)

**ALWAYS use native Claude Code tools instead of bash equivalents:**

| Task | USE THIS (Native Tool) | NOT THIS (Bash) |
|------|------------------------|-----------------|
| Read files | `Read` tool | `cat`, `head`, `tail`, `less` |
| Search file contents | `Grep` tool | `grep`, `rg`, `ack` |
| Find files by pattern | `Glob` tool | `find`, `ls`, `dir` |
| Edit files | `Edit` tool | `sed`, `awk`, `perl -i` |
| Write/create files | `Write` tool | `echo >`, `cat >`, `tee`, heredocs |
| Explore codebase | `Agent` tool (Explore subagent) | Multiple grep/find commands |

**Why this matters:**
- Native tools provide better UX (clickable links, syntax highlighting)
- Native tools are faster and more reliable
- Native tools don't have shell escaping issues
- Native tools work consistently across all platforms

**Only use Bash for:**
- Running actual commands: `git`, `npm`/`pnpm`, `node`, `gh`, etc.
- System operations that require shell execution
- Commands that have no native tool equivalent

## Master Architecture Document (CRITICAL)

**`docs/architecture.md` is the authoritative, technology-agnostic source of truth** —
it owns the **principles, constraints, and stable interfaces**. Movable technology
choices and implementation detail live in the design docs (`docs/design-*.md`). The
full layering is described in [docs/README.md](docs/README.md).

- **NEVER modify `docs/architecture.md`** unless explicitly asked by the user
- Reference it for design decisions, and quote the relevant section when implementing
- If implementation reveals issues with the spec, discuss with the user before changing

**When in doubt, refer to architecture.md.**

## Development Principles (IMPORTANT)

### Handling Failures and Blockers

**When something that should work is failing:**

1. **Do NOT silently work around the problem** - Always inform the user about failures
2. **Present options** - Give the user choices about how to proceed rather than making decisions autonomously
3. **Ask for intervention** - If the user might be able to fix something (permissions, credentials, org policies), ask them to try
4. **Explain the failure** - Provide context about what went wrong and why

**Example options to present:**
- "Would you like me to: (a) try a workaround, (b) skip this for now and continue, (c) wait while you fix the underlying issue?"
- "This failed due to X. You could: (a) grant permission Y, (b) disable this feature, (c) try a different approach"

### Git Workflow Rules

**CRITICAL - Follow these rules for all git operations:**

1. **Never push unless explicitly asked** - Only push commits when the user explicitly requests it
2. **One problem per commit** - Each commit should solve a single, focused problem
3. **Meaningful commit messages** - Describe what and why, not just how
4. **Verify before committing** - Run checks/tests before committing changes

### No Backward Compatibility Required

This project is in **Alpha**: breaking changes, schema changes, and unversioned API
changes are permitted in favour of rapid iteration. See architecture.md Section 2
(Constraints) for the policy.

### Scripts: Bash Only

**Any shell scripts MUST be Bash (`.sh`). Do NOT create PowerShell scripts (`.ps1`).**
CI runs the same bash scripts.

**Every script MUST include a header comment referencing its documentation** — the
relevant design doc (e.g. [docs/design-deployment.md](docs/design-deployment.md)),
`CONTRIBUTING.md`, or its workflow file in `.github/workflows/`:

```bash
#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Script Title
# -----------------------------------------------------------------------------
# Brief description of what the script does.
#
# See <doc> for detailed usage.
#
# Usage:
#   ./scripts/<script-name>.sh [arguments]
# -----------------------------------------------------------------------------
```

### No Dead Code or Stale Documentation

**Git history preserves everything. Don't leave dead artifacts in the codebase.**

- Delete unused code, don't comment it out
- Delete obsolete documentation, don't leave it stale
- Delete unused files, don't rename them with `_old` or `_backup` suffixes
- Remove empty or placeholder files

### Code Standards

This is an **all-TypeScript** codebase. Formatting, linting, and type-checking use
ESLint, Prettier, and `tsc`; tests use Vitest. See [CONTRIBUTING.md](CONTRIBUTING.md)
for how to run them and [docs/design-testing.md](docs/design-testing.md) for test
conventions.

## Working with the Documentation

Documentation follows **Reference, Don't Repeat** and **Keep It DRY** — one
authoritative location per fact, linked from elsewhere. [docs/README.md](docs/README.md)
holds the index, the **documentation flow and layer purpose**, and the design-doc /
roadmap processes. Key rules for AI work:

- **Architecture vs design (altitude rule).** `docs/architecture.md` carries durable
  principles, constraints, and stable interfaces — **no movable technology choices or
  tunable constants**. Those belong in the design docs (`docs/design-*.md`).
- **Design docs** define technology choices and the implementation of architecture's
  interfaces. Read them on-demand before implementing a feature that touches the topic;
  follow their conventions; **propose changes before implementing** (design-doc changes
  are major changes).
- **Roadmap** ([docs/ROADMAP.md](docs/ROADMAP.md)) defines build order and the
  design-doc review process. Consult it when starting/finishing a milestone; update it
  only for milestone-level scope changes.
- **Conflict resolution priority:** architecture.md → design docs → ROADMAP.md. Resolve
  top-down, with user approval for architecture changes.

## Project Overview

**Inbox Clinic** is a privacy-first, **client-only, local-first PWA** for managing a
Gmail / Google Workspace inbox. It runs entirely in the user's browser, talks directly
to Gmail, stores all data on-device, and delegates enforcement to native Gmail filters.
There is **no backend, database, or infrastructure** beyond static hosting. See
architecture.md for the principles and interfaces, and [docs/ROADMAP.md](docs/ROADMAP.md)
for the build structure (an all-TypeScript monorepo: `apps/web` + `packages/core`).

## Development Environment

The project is an **all-TypeScript** monorepo. There are no containers, emulators, or
cloud dependencies for local development — it is a static web app that talks to Google
APIs (mocked in tests). For setup, the dev workflow, and the command reference, see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Configuration

**No secrets in Git, and none at runtime** — by construction. The OAuth client id is
public (PKCE), and the app stores no credentials. For build inputs and deployment, see
[docs/design-deployment.md](docs/design-deployment.md) and architecture.md Section 7.

## Claude Code Configuration

This project is optimized for Claude Code.

### Configuration Files

| File | Purpose | Git Tracked |
|------|---------|-------------|
| `.claude/settings.json` | Permissions and hooks | Yes |
| `.claude/settings.local.json` | Personal overrides | No (gitignored) |
| `CLAUDE.md` (this file) | Project context | Yes |

### Model Usage

The project does not pin a model — Claude Code uses your session default. Switch
per-session with `/model` or `claude --model <model>` as the task warrants.

### Auto-Formatting Hooks

Claude Code automatically formats and validates files after Write/Edit operations (see
`.claude/settings.json`):

| File Type | Action | Hook Script |
|-----------|--------|-------------|
| TypeScript (`.ts/.tsx/.js/.jsx`) | Prettier format | `.claude/hooks/typescript-format.sh` |
| TypeScript (`.ts/.tsx/.js/.jsx`) | `tsc --noEmit` type-check | `.claude/hooks/typescript-typecheck.sh` |
| Documentation | Doc-sync validation | `.claude/hooks/doc-sync-hook.sh` |

Formatting hooks run silently; type-check hooks emit warnings to stderr so issues can be
addressed immediately rather than at commit time.

## Need Help?

- **What to build next**: See [docs/ROADMAP.md](docs/ROADMAP.md) for milestones and design doc review order
- **Architecture (principles & interfaces)**: See [docs/architecture.md](docs/architecture.md)
- **How something is implemented**: See the relevant [docs/design-*.md](docs/README.md)
- **Quick orientation**: Read this file (CLAUDE.md)
- **User guide**: See [README.md](README.md)
- **Contributing**: See [CONTRIBUTING.md](CONTRIBUTING.md)
- **Security & privacy**: architecture.md Sections 5–6; vulnerability reporting in [CONTRIBUTING.md](CONTRIBUTING.md)

---

**When in doubt, check architecture.md for the authoritative specification.**
