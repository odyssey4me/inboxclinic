# Rebuild Plan: Commercial/Team Service → Solo, Client-Only Local-First PWA

**Status:** Proposed — awaiting go-ahead on Phase 1. Earlier confirmations
resolved (cap dropped; hosted-primary access model).
**Goal:** Replace the commercial, team-built hybrid-cloud service with a
**solo-maintained, open-source, client-only local-first PWA**. The user's data
and all Gmail interaction live on the device; enforcement is delegated to native
Gmail filters (run by Google). **v1 has no backend, no database, no running
infrastructure, and no in-repo secrets.** Every removed capability has a designed
seam to add back later.

## How we got here (decision trail)

Small-public/solo-run → cloud-serverless only → **local-first, no server-side
token custody** (model B) → enforcement via native Gmail filters → the server's
only remaining job was the anonymous aggregate → **aggregate deferred** → therefore
**no backend at all in v1**. Client-only collapses cost-driven concerns (e.g. the
per-user cap) because there is no per-user cloud cost.

## v1 target state (decisions)

| Axis | Decision |
|------|----------|
| Shape | **Client-only static PWA.** No backend, no DB, no Pub/Sub, no KMS, no Cloud Run, no workers. |
| Language | **All-TypeScript** (falls out for free — there is no server to need a second language). |
| Client stack | **Vite + React SPA**, **Dexie (IndexedDB)** local store, **PWA from day one** (offline + installable). Static build, host anywhere. |
| Privacy model | Gmail data + decisions stay **on-device**. Gmail accessed **directly from the browser** via **PKCE public client** (short-lived access tokens, **no refresh token stored on web, no client secret**). Enforcement = **native Gmail filters**. "We never see your email and never hold your credentials" is true by construction. |
| Core logic | **Framework-agnostic plain TS** modules (trust logic, Gmail-filter compilation, local-store schema, future aggregate-contribution interface) — reusable by web today and Capacitor/RN later. |
| Mobile (iOS + Android) | **Deferred, kept open.** Capacitor is the cheapest route (wrap the same SPA; unlocks Keychain/Keystore + background + push); RN is the fallback; PWA is the immediate baseline. Kept open via framework-agnostic core + platform-capability interfaces + repository interface over the store. |
| Access model | **Confirmed:** Google OAuth project in **"testing" mode with a test-user allowlist (≤100)** — naturally enforces "small public" and avoids restricted-scope verification + CASA. Old `MAX_USERS` cap dropped (no per-user cost). Hosted instance is primary; self-host documented as an option. |
| Waitlist / request access | **Static "Request access" flow** in the PWA + README (shown beside "Sign in" so non-allowlisted users don't dead-end on Google's block). Posts to a **privacy-respecting hosted form** (no backend code of ours; **Tally** preferred for EU/GDPR, or Google Forms). Collects **Google email + optional note only**, delivered **privately** (not public). Operator adds the email to OAuth test users, then **deletes the request** (data minimization). Transparent note: used only to grant access, unrelated to inbox data. Migratable to the future backend seam. |
| Hosting | **Static files only** (GitHub Pages / Cloudflare Pages / any CDN). Near-zero lock-in. |
| Secrets | **None in repo, none at runtime on web.** OAuth client id is public (PKCE). Deploys via static-host CI; if any cloud is used later, GitHub→cloud auth uses **Workload Identity Federation (OIDC)**, no long-lived keys. |
| Revenue | **GitHub Sponsors** link (README + app footer). No billing code. |
| User settings & opt-ins | **No build-time/server flag layer.** Every capability is always-on or a **user-controlled opt-in/opt-out** toggle in the Settings screen, persisted **on-device** (IndexedDB). No server, no per-user maintainer targeting (architecture §8). |
| Repo | **One public monorepo** (`apps/web`, `packages/core`, later `apps/mobile`, `services/aggregate`). Owner `odyssey4me/inboxclinic`, SSH remote. |
| License | **Apache-2.0** (fix `pyproject.toml`, which currently declares AGPLv3+). |

## Deferred — future expansions (build seams now, code later)

| Capability | Seam kept in v1 |
|------------|-----------------|
| Collective trust intelligence (anonymous, opt-out — a user opt-out setting) | Framework-agnostic **contribution interface** in `packages/core`; no network calls yet. |
| Aggregate backend + datastore + cloud choice | Deferred entirely — choose language/datastore/host when built, behind the contribution interface. |
| Mobile apps (iOS/Android) | Platform-capability + repository interfaces; Capacitor-friendly static SPA. |
| Server-side real-time triage (beyond native filters) | Would reintroduce a backend + token custody; explicitly avoided unless needed. |

## What is removed (almost the entire current repo)

- All backend/server code: `src/frontend/api/**`, `src/workers/**`.
- All cloud infra: `terraform/**`, `k8s/**`, `docker/**` server images, ArgoCD/ESO.
- Bootstrap/ops for the above: most of `scripts/**`, `docs/operations/**`.
- Growth/commercial machinery: invitation/referral/rewards/waves, admin dashboard,
  impersonation, public status page, server-side analytics.
- The existing Next.js frontend (replaced by the Vite SPA).

## What is salvaged (reference, not kept as-is)

- **Domain knowledge** in `docs/architecture.md` and the Gmail design
  docs (sender extraction, trust scoring, filter sync) — mined for the rewrite,
  then the docs are replaced.
- **Gmail-filter logic** in `src/workers/shared/gmail/**` — reimplemented in TS,
  client-side, as the reference for behaviour.

---

## Phases

### Phase 1 — Docs (architecture leads code)
- Rewrite `docs/architecture.md` to the client-only PWA scope
  (target ~400–600 lines): on-device data model, browser Gmail OAuth (PKCE),
  native-filter enforcement, local store, PWA, deferred-aggregate seam, mobile seams,
  open-source/no-secrets posture, Apache-2.0.
- Replace the design-doc set: keep/rewrite **gmail-integration**, **trust-decisions**,
  **frontend**, **testing**; add **local-store schema** and **user-settings**;
  delete backend/infra/growth/admin docs.
- Rewrite `docs/README.md` index and `docs/ROADMAP.md` for the new scope.

### Phase 2 — Strip to a clean slate
- Remove `src/`, `terraform/`, `k8s/`, `docker/`, server-side `scripts/`, obsolete docs.
- Reset `pyproject.toml`/Python tooling (no longer needed) and Claude hooks for Python.
- Remove stack-tied editor/root config: `.vscode/` (Python/Terraform/K8s extensions +
  settings, stale arch ref, Copilot attribution), `.terraform-version`, the Python
  `Makefile` targets, and `.github/workflows/test.yml` (rewritten for TS in M0/scaffold).
  A fresh TS-oriented `.vscode/` is created in Phase 3.

### Phase 3 — Build the client-only PWA
- Scaffold monorepo: `apps/web` (Vite + React + Tailwind), `packages/core` (framework-agnostic TS).
- Implement: Google PKCE OAuth in-browser, Gmail scan/sender-extraction, trust-decision
  flow, **native Gmail filter compilation + sync**, Dexie local store, PWA/offline.
- Stub the aggregate **contribution interface** (no network).

### Phase 4 — Open-source hygiene & deploy
- Apache-2.0 everywhere; verify zero secrets; static-host CI (GitHub/Cloudflare Pages).
- README (self-host + hosted instructions), GitHub Sponsors link, `odyssey4me/inboxclinic` remote.

### Phase 5 — Tests & CI
- Vitest for `packages/core` + `apps/web`; component/integration tests with mocked Gmail.
- Lint/format/typecheck (one TS toolchain). Coverage gate retained.

## Commit strategy
One focused commit per problem; no pushes until requested.
