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
| `BASE_PATH` | no | `/` | Public base path; default `/` (Cloudflare Pages / custom-domain root). Set `/sub/` only for sub-path self-hosting. |

e.g. `VITE_OAUTH_CLIENT_ID=xxx npm run dev`. There is **no `.env` with secrets** — the
client id is public by design (PKCE), and nothing secret is ever stored.

### Checks

```bash
npm test             # Vitest (unit + component)
npm run lint         # ESLint
npm run format       # Prettier
npm run typecheck    # tsc --noEmit
```

**End-to-end (Tier 3, Playwright):** drives the built app through its no-Google
[demo mode](docs/design-frontend.md) — no account or network needed.

```bash
npx playwright install   # one-time: download browsers (add --with-deps on Linux/CI)
npm run e2e              # build + preview + run chromium/firefox/webkit/mobile
npm run e2e:ui          # interactive runner while writing specs
```

Test structure, tiers, mocking, and fixtures: [docs/design-testing.md](docs/design-testing.md).
Coverage gate: **≥80%** on `packages/core` and `packages/store` logic.

### Dependency updates

**Renovate** opens update PRs; CI gates every merge. Coupled ecosystems (vite, eslint, types)
are **grouped** so they move atomically, and low-risk updates **auto-merge on green** — while
bundle-affecting (incl. vite) and runtime majors are held for manual review. The policy and
its reasoning ("can it reach users?") live in
[docs/design-deployment.md](docs/design-deployment.md#dependency-updates-renovate).

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

**Dependencies — use the ecosystem.** Reach for a well-supported, replaceable library
when it gives substantive benefit at acceptable risk and lock-in, rather than hand-rolling
what a stable library does well (architecture.md §1, *Use the ecosystem*). Add it to the
relevant workspace, and let CI (which gates every dependency PR) and Renovate keep it
current.

## Pull request process

PRs must pass: Prettier (format), ESLint (lint), `tsc` (types), and Vitest (tests,
≥80% core coverage). In the description, include a summary, any linked issue
(`Fixes #123`), how you tested it, and any breaking changes (allowed in Alpha).

**Landing a PR — keep `main` linear and one-problem-per-commit.** Merge commits are
disabled; land via **squash** or **rebase**, chosen to keep every commit on `main` a single
coherent problem (see [Git workflow](#git-workflow) above):

- **Squash** when the branch is one logical change plus fixups — review tweaks, "fix my own
  test", a follow-up doc-sync — collapsing them into one well-described commit.
- **Rebase** when the branch is genuinely a series of independent commits, each solving a
  distinct problem worth keeping.

Delete the branch on merge (e.g. `gh pr merge <n> --squash --delete-branch`).

## Reviewing for privacy & architecture invariants

Inbox Clinic's identity is its constitution — **privacy by construction, client-only, no
credential custody** (architecture.md §1, §2, §5). Those invariants are subtle to break
in code. When reviewing (or writing) a change that touches networking, storage, auth
scopes, logging, diagnostic reporting, or `packages/core`, watch for these code smells;
each links to the clause it risks. This checklist is *detection guidance* — the
authoritative rules live in the linked docs, not here.

| Watch for (in the diff) | Risks the invariant owned by |
|-------------------------|------------------------------|
| `fetch`/XHR/WebSocket/beacon to a host that isn't the Gmail API or the sanctioned reporting path | On-device-only data — architecture.md §1, §5; [design-error-reporting.md](docs/design-error-reporting.md) |
| Tokens/passwords written to the store, IndexedDB, `localStorage`/`sessionStorage`, cookies, a file, or a log | No credential custody — §2, §5; [design-local-store-schema.md](docs/design-local-store-schema.md), [design-gmail-integration.md](docs/design-gmail-integration.md) |
| Requesting/storing/transmitting message **bodies** or content-bearing snippets (not metadata) | Metadata-only — §5 |
| Raw addresses, message ids, subjects, or headers reaching a report payload or `console.*`/log without redaction or explicit user submission | Redacted, opt-in diagnostics — §5; [design-error-reporting.md](docs/design-error-reporting.md) |
| Hardcoded API keys, private keys, or service credentials in source/config | No secrets in repo or client — §7; [design-deployment.md](docs/design-deployment.md) |
| OAuth scopes broadened beyond the touched feature's need | Least-permission — §6; [design-gmail-integration.md](docs/design-gmail-integration.md), [design-backup-restore.md](docs/design-backup-restore.md) |
| `packages/core` importing React/DOM/browser globals, a provider SDK, `apps/web`, or a storage technology; or a scoring function doing I/O | Pure, provider- & UI-agnostic core — §6; [design-trust-decisions.md](docs/design-trust-decisions.md) |
| A new application server, server-side store of user data, analytics/telemetry SDK, or maintainer-controlled per-user flag | Client-only, no feature-flag system — §1, §2, §3, §8 |

**Sanctioned** (don't flag, but confirm the shape matches): direct Gmail API calls; the
opt-in, redacted diagnostic report to the Cloudflare feedback function
([design-error-reporting.md](docs/design-error-reporting.md)); and the public OAuth
client id (PKCE) + Turnstile on that function. A *new* egress or store that merely
*resembles* one of these is still a finding.

The `inbox-clinic-auditor` subagent automates this checklist — see
[CLAUDE.md](CLAUDE.md).

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
