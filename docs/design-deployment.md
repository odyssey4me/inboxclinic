# Deployment, Access & Open-Source Operations

> **Status:** Draft
>
> **Last Updated:** 2026-06-28

## Overview

This design document makes the **movable technology and operational choices** for
hosting, building, access control, and funding — the concrete realisation of the
durable principles in architecture.md. It exists so those choices live in one place
and can change without touching the architecture.

## Architecture Reference

| Section | Title | Relevance |
|---------|-------|-----------|
| 2 | Constraints | Gmail-only, client-only, no credential custody, allowlist access, Apache-2.0 |
| 7 | Access, Openness & Funding | Implements the access/openness/funding principles concretely |

> **Keep It DRY:** architecture.md states *that* access is allowlist-gated, the app is
> open-source with no secrets, and funding is donations only. This doc chooses *how*.

## Design Decisions

### Hosting: static files on a CDN
**Decision:** ship the client as static assets on **GitHub Pages** (or Cloudflare
Pages). **Rationale:** no servers to run or patch; near-zero cost; portable (static
files move to any host). **Alternatives:** a container host (unnecessary — no backend);
a single VPS (always-on, you own patching).

### No secrets: public OAuth client + PKCE
**Decision:** the app uses a **public OAuth client with PKCE**; the **client id is
public** and ships in the build. No client secret, no refresh token stored on web.
**Rationale:** nothing secret to protect, so the repo and the running client hold no
secrets. **Future cloud:** if any cloud resource is ever added, GitHub→cloud auth uses
**Workload Identity Federation (OIDC)** — no long-lived keys.

### Hosting target: GitHub Pages
**Decision (M8):** the primary hosted instance ships to **GitHub Pages** via the official
Pages Action, publishing on push to `main` with **OIDC** (`id-token`/`pages` permissions)
— **no deploy secret**. As a GitHub *project* page it is served under a sub-path, so the
build sets **`BASE_PATH=/inboxclinic/`**; self-host/root builds use the default `/`.
**Rationale:** the repo already lives on GitHub; zero extra accounts or tokens; portable
static output. Cloudflare Pages remains a drop-in alternative (needs a CF account + API
token) if a root-path URL or custom domain is wanted later.

### Access: Google OAuth project in "testing" mode
**Decision:** one Google Cloud OAuth project in **"testing" mode** with a **test-user
allowlist (≤100)**. **Rationale:** naturally bounds the user base to "small" and avoids
restricted-scope **verification + the annual CASA security assessment** that a public
app with Gmail modify/settings scopes would require. **Self-host:** a user may run their
own build against their **own** OAuth client (themselves as the only test user).
**Allowlist management (M8):** kept a **manual maintainer runbook** (add test user →
confirm → delete the request) rather than automated — appropriate at ≤100 users. See
[runbook-access.md](runbook-access.md).

### Request-access (waitlist)
**Decision:** a **"Request access"** action (shown beside sign-in) posts to a
**hosted form — [Tally](https://tally.so)** (EU/GDPR-friendly) — collecting only a
**Google email + optional note**, delivered **privately** to the maintainer.
**Rationale:** no backend code of ours; minimal, private data. **Runbook:** maintainer
adds the email to the OAuth test users, confirms, then **deletes the request**.
**Migration:** if a backend is ever added, this becomes a write-only endpoint with no
UX change.

### Funding: GitHub Sponsors
**Decision:** a **GitHub Sponsors** link in the root README and the app footer. No
billing code, tiers, or accounts.

### Licence: Apache-2.0
Applied across the repository: the root `LICENSE`, `package.json` `license` fields, and a
per-file **SPDX one-liner** header — `// SPDX-License-Identifier: Apache-2.0` — at the top
of each source file (lightweight, machine-readable; no full copyright block).

## Interfaces

### Build inputs (public, non-secret)

Client build inputs are read by Vite and therefore carry the **`VITE_` prefix**; the
deploy workflow maps repo **variables** (`vars.OAUTH_CLIENT_ID`, `vars.REQUEST_ACCESS_URL`)
onto them at build time. All are **public, non-secret**.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VITE_OAUTH_CLIENT_ID` | Yes | – | Public Google OAuth client id for the deployment. |
| `VITE_REQUEST_ACCESS_URL` | No | repo issues | URL of the Tally request-access form; the link falls back to the repo issues page when unset. |
| `BASE_PATH` | No | `/` | Public base path; `/inboxclinic/` for the GitHub *project* Pages URL, `/` for self-host at a domain root. |

### CI pipeline (conceptual)

`lint → typecheck → test → build (static) → publish to Pages`. No secrets are required
to build; publishing uses the host's native deploy token/OIDC, not a committed key.
Realised as two workflows: **`ci.yml`** (lint/typecheck/test/coverage/build + a
**zero-secrets** grep) on every push/PR, and **`deploy.yml`** (build + GitHub Pages via
OIDC) on push to `main`.

## Configuration

- **OAuth scopes** are requested incrementally by the client (see
  [design-gmail-integration.md](design-gmail-integration.md)); the consent screen lists them.
- **Allowlist** is managed in the Google Cloud console (OAuth consent → Test users).

## Error Handling

- **Non-allowlisted sign-in** → the provider blocks consent; the UI must pre-empt this
  with the "Request access" path rather than dead-ending on the provider's error.
- **Publish failure** in CI → fail the workflow; the previous deployment stays live.

## Examples

- **Reproduce/self-host:** fork → set `OAUTH_CLIENT_ID` (and optionally
  `REQUEST_ACCESS_URL`) → CI publishes static assets. Substitute your own OAuth client
  to self-host.

## Open Questions

- ~~GitHub Pages vs Cloudflare Pages as the primary host.~~ **Resolved (M8): GitHub
  Pages** (see *Hosting target*); Cloudflare remains a drop-in alternative.
- ~~Automate the allowlist-add step or keep a manual runbook.~~ **Resolved (M8): manual
  runbook** ([runbook-access.md](runbook-access.md)) — fine at ≤100 users.

---

**Changelog:**

| Date | Change | Author |
|------|--------|--------|
| 2026-06-28 | Initial draft — hosting, no-secrets, access/testing-mode, Tally waitlist, Sponsors, licence, moved out of the re-levelled architecture.md. | Claude |
| 2026-07-05 | M8: resolve open questions (host = GitHub Pages via OIDC; manual allowlist runbook); align build inputs to `VITE_`-prefixed names + `BASE_PATH`; note the SPDX per-file header convention; split CI/deploy workflows with a zero-secrets check. | Claude |
