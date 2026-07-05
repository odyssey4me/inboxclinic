# Contributing to Inbox Clinic

Thanks for your interest in contributing to Inbox Clinic!

## Before you start

Read **[docs/architecture.md](docs/architecture.md)** (the durable principles,
constraints, and stable interfaces) and the relevant **[design doc](docs/README.md)**
(`docs/design-*.md`, which carry the technology choices and implementation detail).
[docs/README.md](docs/README.md) explains how the documentation layers fit together.

> **Status:** Alpha — the project is being rebuilt into an **all-TypeScript,
> client-only, local-first PWA** (`apps/web` + `packages/core`). The setup below
> describes the target workflow as the scaffold lands; see
> [docs/ROADMAP.md](docs/ROADMAP.md).

## How to contribute

**Looking for something to work on?** Check
[GitHub Issues](https://github.com/odyssey4me/inboxclinic/issues).

- **Bugs** — check existing issues first; include steps to reproduce, expected vs
  actual behaviour, and any console errors.
- **Features** — check architecture.md for alignment, then open a feature request
  describing the use case and problem.
- **Code** — fork, branch (`git checkout -b feature/your-thing`), follow architecture
  and the relevant design doc, add tests, ensure checks pass, and open a PR.

## Development setup

### Prerequisites

- **Node.js** (current LTS) and **npm**
- **Git** with the **GitHub CLI** (`gh auth login`)
- A **Google Cloud OAuth client** if you want to run against a real inbox (see
  [docs/design-deployment.md](docs/design-deployment.md))

No backend, database, containers, or cloud infrastructure are required.

### Local development

```bash
git clone git@github.com:odyssey4me/inboxclinic.git
cd inboxclinic
npm install
npm run dev          # start the Vite dev server
```

Most development needs no real credentials — tests mock the Google APIs at the client
boundary. To run against a real inbox or to build for deployment, set these **public,
non-secret** build inputs (see [docs/design-deployment.md](docs/design-deployment.md)):

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `VITE_OAUTH_CLIENT_ID` | to sign in | – | Your public Google OAuth (PKCE) client id. |
| `VITE_REQUEST_ACCESS_URL` | no | repo issues | Request-access (waitlist) form URL. |
| `BASE_PATH` | no | `/` | Public base path (`/inboxclinic/` for GitHub project Pages). |

e.g. `VITE_OAUTH_CLIENT_ID=xxx npm run dev`. There is **no `.env` with secrets** — the
client id is public by design (PKCE), and nothing secret is ever stored.

### Checks

```bash
npm test             # Vitest (unit + component)
npm run lint         # ESLint
npm run format       # Prettier
npm run typecheck    # tsc --noEmit
```

Test structure, mocking, and fixtures: [docs/design-testing.md](docs/design-testing.md).
Coverage gate: **≥80%** on `packages/core` logic.

## Working with the documentation

One authoritative location per fact. **architecture.md** owns durable principles and
interfaces — **do not edit it without maintainer approval**. **Design docs** own
technology and implementation; propose design-doc changes (a major change) before
implementing. See the boundary rules in [docs/README.md](docs/README.md).

## Git workflow

- Branch off `main`; **one focused problem per commit**; describe *what* and *why*.
- When using Claude Code (or the project git hooks), Prettier, `tsc`, and doc-sync run
  automatically on changed files (see `.claude/settings.json`).
- Commit attribution is configured in `.claude/settings.json`.

## Code standards

All-TypeScript: **ESLint + Prettier + `tsc` (strict)**, tested with **Vitest**. Keep
the core (`packages/core`) framework-agnostic and pure where possible. No dead code or
stale documentation (see [CLAUDE.md](CLAUDE.md)).

## Pull request process

PRs must pass: Prettier (format), ESLint (lint), `tsc` (types), and Vitest (tests,
≥80% core coverage). In the description, include a summary, any linked issue
(`Fixes #123`), how you tested it, and any breaking changes (allowed in Alpha).

## Security vulnerabilities

If you discover a security vulnerability:

1. **Do not** open a public GitHub issue.
2. Report it privately to the maintainer.
3. Include a description and reproduction steps, and allow reasonable time for a fix
   before disclosure.

Privacy and security design: architecture.md Sections 5–6.

## Getting help

- **architecture.md** for design questions; **[docs/README.md](docs/README.md)** for the doc map.
- **Existing issues** for similar problems — be specific about what you tried.

Thank you for contributing to Inbox Clinic!
