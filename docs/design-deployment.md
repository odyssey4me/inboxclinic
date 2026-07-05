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

### Hosting target: Cloudflare Pages
**Decision (M8):** the primary hosted instance ships to **Cloudflare Pages**, served at the
**root** of the custom domain (`inboxclinic.com`), so the build uses the default base `/`
(no `BASE_PATH`). **Rationale:** DNS already lives on Cloudflare, so Cloudflare Pages
collapses DNS + CDN + automatic TLS + **edge request analytics** (cookieless, no client
tracker — fits the privacy-first posture) into one place, and avoids the
GitHub-Pages-behind-a-Cloudflare-proxy conflict (a proxied domain blocks GitHub's cert
provisioning). Static output stays portable — any static host works for self-host.
**Superseded:** an earlier M8 iteration targeted **GitHub Pages** (Pages Action + OIDC,
`BASE_PATH=/inboxclinic/`); it was dropped because GitHub Pages exposes no site analytics
and cannot set custom HTTP headers (e.g. CSP), and stacking Cloudflare's proxy in front
broke HTTPS. GitHub Pages remains a viable no-analytics fallback.
**Deploy:** Cloudflare Pages builds are configured with build command `npm run build`,
output `apps/web/dist`, and env `VITE_OAUTH_CLIENT_ID` (+ optional `VITE_REQUEST_ACCESS_URL`).
Hosting config lives in `apps/web/public/_redirects` (SPA fallback) and `_headers`
(security headers). GitHub Actions (`ci.yml`) stays as the test/build/zero-secrets gate.

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

`lint → typecheck → test → build (static) → publish`. No secrets in the build. Realised as
**`ci.yml`** (lint/typecheck/test/coverage/build + a **zero-secrets** grep) on every
push/PR as the quality gate; **publishing** is handled by **Cloudflare Pages** — either its
Git integration (Cloudflare builds on push) or `wrangler pages deploy` from CI with a
Cloudflare API token.

### Dependency updates (Dependabot)

Dependabot opens update PRs; **CI is the gate** (branch protection requires the
lint/typecheck/test/build check to pass before any merge). Three conventions keep this
safe *and* low-toil — the reasoning matters for future changes:

**1. Auto-merge policy — "can it reach users?"** A major is safe to auto-merge on green
**only if it cannot reach users**: it never ships in the bundle and CI fully exercises it,
so the worst case is a red CI (merge blocked), never a broken app. Encoded in
`.github/workflows/dependabot-automerge.yml`:

| Update | Auto-merge on green? | Why |
|--------|----------------------|-----|
| npm **minor/patch** | ✅ | Low risk. |
| **GitHub Actions** (incl. majors) | ✅ | The action runs *inside* the gating CI — green = proof. A bad deploy-only action just fails the next deploy (Pages keeps serving the last good build). Actions are SHA-pinned; Dependabot maintains the hash + `# vX` comment. |
| npm **majors** — non-shipping dev tooling + type defs | ✅ | `@types/*`, `jsdom`, `eslint`/`@eslint/*`/`eslint-plugin-*`/`typescript-eslint`, `prettier`, `@testing-library/*`, `globals`, and **`typescript`** (used only for `tsc --noEmit` — vite/esbuild transpiles, so a TS major never touches the shipped bundle). These never ship; a break only turns CI red. |
| npm **majors** — everything else | ❌ manual | Bundle-affecting build tools (`vite`, `vite-plugin-*`, `@vitejs/*`) can pass the build yet change runtime output; runtime deps (`react`, `dexie`, …) can pass build and break at runtime. |

**2. Grouping — coupled ecosystems move atomically.** Packages that share peer ranges must
version together or npm leaves a duplicate/incompatible major (e.g. a lone `vite` bump
strands `vite@6` under `vitest`). `.github/dependabot.yml` groups them (`vite`, `eslint`,
`types`) so each ecosystem is **one all-or-nothing PR**. Grouping gives *atomicity*; it does
**not** do peer-compatibility-aware waiting — so **CI is the compatibility gate**: an
incompatible partial group fails and can't merge.

**3. Duplicate-major guard.** `scripts/check-no-dup-majors.sh` (a CI step) fails if a
critical package (`vite`, `vitest`, `react`, `react-dom`) resolves to more than one major.
This catches the "works-but-messy" case that peer-strictness does *not* — it's duplication,
not a peer violation. Reconcile with the relevant Dependabot group + `npm dedupe`/`npm why`.

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

- ~~GitHub Pages vs Cloudflare Pages as the primary host.~~ **Resolved (M8): Cloudflare
  Pages** (see *Hosting target*) — single-vendor DNS+CDN+TLS+analytics; GitHub Pages was
  tried first and dropped (no site analytics, no custom headers, proxy-vs-cert conflict).
- ~~Automate the allowlist-add step or keep a manual runbook.~~ **Resolved (M8): manual
  runbook** ([runbook-access.md](runbook-access.md)) — fine at ≤100 users.

---

**Changelog:**

| Date | Change | Author |
|------|--------|--------|
| 2026-06-28 | Initial draft — hosting, no-secrets, access/testing-mode, Tally waitlist, Sponsors, licence, moved out of the re-levelled architecture.md. | Claude |
| 2026-07-05 | M8: resolve open questions (host = GitHub Pages via OIDC; manual allowlist runbook); align build inputs to `VITE_`-prefixed names + `BASE_PATH`; note the SPDX per-file header convention; split CI/deploy workflows with a zero-secrets check. | Claude |
| 2026-07-05 | Switch hosting to **Cloudflare Pages** (root domain, base `/`): single-vendor DNS+CDN+TLS + cookieless edge analytics; drop the GitHub Pages deploy workflow + CNAME; add `_redirects`/`_headers`. GitHub Pages could not front-with-Cloudflare-proxy (cert conflict) and gave no site stats/custom headers. | Claude |
| 2026-07-05 | Document the Dependabot strategy: "can it reach users?" auto-merge policy (minor/patch + Actions + non-shipping dev-tooling majors; bundle/runtime majors manual), atomic ecosystem grouping (vite/eslint/types) with CI as the compatibility gate, and the duplicate-major guard. | Claude |
