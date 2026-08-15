# Inbox Clinic — Build Roadmap

> **Status:** Approved
>
> **Last Updated:** 2026-08-15

This roadmap defines the build path for the **client-only, local-first PWA**
(see [architecture.md](architecture.md)). It supersedes
the previous hybrid-cloud roadmap; the rationale is in
[descope-plan.md](descope-plan.md).

## Overview

The product is built from scratch as an **all-TypeScript monorepo** — `apps/web`
(Vite + React + Tailwind PWA) over `packages/core` (framework-agnostic logic). No
backend, no database, no infrastructure beyond static hosting.

Milestones are ordered so each delivers something usable on its own. Earlier
milestones (M0–M2) are largely independent of the UI; M3+ build the experience on
top.

## Design-Doc Review Process

Before starting a milestone, **read and confirm** the listed design docs (propose
changes before implementing — design-doc changes are major changes). All docs are
**Draft** during Alpha; refinement is expected as implementation reveals detail.

| Milestone | Design docs to confirm |
|-----------|------------------------|
| M0 Scaffold | design-testing.md |
| M1 Auth & scan | design-gmail-integration.md, design-local-store-schema.md |
| M2 Scoring & prompts | design-trust-decisions.md |
| M3 Decision UI | design-frontend.md |
| M4 Enforcement | design-gmail-integration.md (filters), design-trust-decisions.md (actions) |
| M5 Sync & PWA | design-gmail-integration.md (History sync), design-frontend.md (service worker) |
| M6 Analytics | design-frontend.md (analytics views) |
| M7 Backup & restore | design-backup-restore.md, design-local-store-schema.md |
| M8 Access & release | design-frontend.md (settings) |
| M9 Consolidated consent | design-gmail-integration.md (Decisions 1–2), design-backup-restore.md (Decisions 2 & 4) |

---

## Milestones

### M0 — Repo reset & scaffold — ✅ COMPLETE
**Goal:** a clean monorepo that builds, lints, type-checks, tests, and deploys an
empty static PWA shell.
- Remove the old `src/`, `terraform/`, `k8s/`, `docker/`, server scripts, Python tooling.
- Scaffold `apps/web` (Vite + React + Tailwind + PWA plugin) and `packages/core`.
- One TS toolchain: ESLint + Prettier + `tsc` + Vitest; coverage gate wired.
- CI: build + test + publish static assets (GitHub/Cloudflare Pages).
- **Exit:** `main` deploys a blank installable PWA; CI green.

### M1 — Auth & inbox scan (read-only) — ✅ COMPLETE
**Goal:** sign in and see your senders.
- Browser PKCE OAuth (Google Identity Services), `gmail.readonly`, in-memory token
  (the read-only-first grant is superseded by **M9**).
- Bounded metadata scan (default 30 days), sender/domain extraction & categorisation.
- Dexie local store (profile, senders, domains) per `design-local-store-schema.md`.
- **Exit:** authenticated scan populates the on-device sender/domain list.

### M2 — Trust scoring & prompt generation — ✅ COMPLETE
**Goal:** prioritised decisions to make.
- Pure `packages/core` scoring (v1: User×0.77 + Compliance×0.23) and prioritisation.
- Generate/store prompts with priority + batch grouping; 30-day TTL.
- **Exit:** the store holds correctly scored, prioritised prompts; covered by unit tests.

### M3 — Trust-decision workflow (UI) — ✅ COMPLETE
**Goal:** make decisions.
- Four-phase flow (Discovery → Decision → Review → Execution) over local data.
- Dashboard shell; record Trust/Block/Defer decisions; scope override (domain > address).
- **Exit:** a user can work through prompts and persist decisions locally.

### M4 — Enforcement & actions — ✅ COMPLETE
**Goal:** decisions take effect in Gmail.
- Escalate to `gmail.modify` + `gmail.settings.basic` (the escalation is superseded by
  **M9**; the scopes are now granted at sign-in).
- Native-filter compilation (domain aggregation, OR-combine, ~450 soft cap).
- Block actions: filter, archive, delete, unsubscribe; Trust rescue from Spam/Trash.
- **Exit:** blocks produce native Gmail filters; actions apply with a result summary.

### M5 — Incremental sync & PWA hardening — ✅ COMPLETE
**Goal:** stays current and works offline.
- History-API incremental sync with stored `historyId` + 404 rescan recovery.
- Service worker: offline cache + periodic background sync; filter reconciliation.
- **Exit:** reopening updates state without a full rescan; usable offline.

### M6 — Analytics & dashboard — ✅ COMPLETE
**Goal:** see the impact.
- Daily/monthly local analytics; inbox health score; category breakdown; top domains.
- Achievements + opt-in **local** shareable snapshot (no server, no referral tracking).
- **Exit:** analytics reflect activity; a snapshot can be exported/shared locally.

### M7 — Backup & restore (Google Drive) — ✅ COMPLETE
**Goal:** durable, user-owned backup; move to a new device.
- Opt-in setting (default off); incremental `drive.file` scope requested on enable
  (both superseded by **M9**: default on, scope granted at sign-in).
- Back up: `exportAll()` → a visible `Inbox Clinic Backup.json` in the user's own
  Drive (updated in place). Manual "Back up now".
- Restore: download → `importAll()` (replace-local with a warning). Not sync.
- **Exit:** a user can back up to their Drive and restore on a fresh install.

### M8 — Access, waitlist & open-source release — ✅ COMPLETE
**Goal:** others can use it (and self-host).
- "Request access" flow → Tally form (Section 7); maintainer allowlist runbook.
- Apache-2.0 headers/licence verified; zero-secrets check; GitHub Sponsors link.
- README: hosted + **self-host** instructions; `odyssey4me/inboxclinic` remote.
- **Exit:** a fresh fork can build, deploy, and onboard allowlisted users.

### M9 — Consolidated consent & default-on backup — ✅ COMPLETE
**Goal:** ask for permission once, and protect the user's decisions without being asked.
- Incremental scope tiers replaced by a **single grant at sign-in** covering
  `gmail.modify`, `gmail.settings.basic`, and `drive.file` (architecture v3.3 §6).
  `gmail.readonly` dropped — a subset of `gmail.modify` in the same grant buys nothing.
  Scope-escalation machinery removed; one token, shared by the Gmail and Drive adapters.
- Re-authentication on token expiry requests the **same full set**, so a session cannot
  silently come back narrower than it started. Silent renewal (GIS `prompt: ""`) removes
  the hourly interruption, bounded to **attended sessions**: a hidden or idle session
  lapses rather than renewing *or* prompting, and no timer-driven path may prompt.
- **Sign out** replaces "Disconnect" and **revokes** the grant, so the credential does
  not outlive the session the user ended.
- Backup **on by default** (architecture v3.3 §5/§8), backing up automatically and
  best-effort after a decision batch (debounced), with "Back up now" retained.
- **Exit:** a full session — sign in, scan, decide, enforce, back up — shows the user
  exactly **one** consent screen (asserted in `consolidatedConsent.test.ts`).

---

## Delivered after v1

| Item | Notes |
|------|-------|
| **Demo mode + Tier-3 E2E** — ✅ COMPLETE | A no-Google `?demo` path with curated in-memory data (`@inboxclinic/core/demo`) so anyone can explore the full product, plus **Playwright** end-to-end tests driving it (Discovery → Decision → Review → Execution, backup/restore, layout switch) across chromium/firefox/webkit/mobile as a required CI gate. See [design-testing.md](design-testing.md) Decision 7 and [design-frontend.md](design-frontend.md) (Demo mode). |
| **Opt-in feedback / error reporting** — ✅ COMPLETE | User-initiated, redacted, anonymous diagnostic report → GitHub issue via a Cloudflare Pages Function (Turnstile + KV rate-limiting, anonymous install ID). Copy/download works with no backend; the edge submit is live on inboxclinic.com. Establishes the shared edge + anti-abuse foundation for the deferred aggregate. See [design-error-reporting.md](design-error-reporting.md) (Approved) and architecture v3.1 (§5 second egress, §6 Reporting client). |

---

## Deferred (post-v1)

| Item | Notes |
|------|-------|
| **Collective trust intelligence** | Anonymous, opt-out aggregate (a user setting). Build behind the `packages/core` contribution interface; choose backend/datastore then (architecture §9). The **edge backend + anti-abuse foundation** (Cloudflare Workers, Turnstile, KV rate-limiting, cloud-neutral reporting port) is now established by [design-error-reporting.md](design-error-reporting.md) and reused here — with **distinct identity handling** (aggregate stays non-identifiable). |
| **Mobile apps (iOS/Android)** | Capacitor wrap of the SPA first; React Native fallback. Kept open via platform-capability + repository interfaces. |
| **Server-side real-time triage** | Deliberately avoided (would reintroduce a backend + token custody). |
| **Backup triggers & frequency** | Event-driven auto-backup lands in **M9**; the specific trigger and the 30s debounce are a first guess to revisit against real usage — issue #246. Client-side encryption of the backup blob is issue #245. |
| **`inContacts` trust signal (+2)** | `contacts.readonly` (People API) lookup. The schema field and scoring branch exist as a seam; the lookup itself is not built, so the field is always `false` and the signal never fires. The scope is **not** in the sign-in grant until the lookup ships, at which point it joins that single grant rather than prompting separately ([design-gmail-integration.md](design-gmail-integration.md) Decision 2). See also [design-trust-decisions.md](design-trust-decisions.md). |

## Notes

- **Conflict resolution priority:** architecture.md → design docs → ROADMAP.md.
- Update this roadmap only for milestone-level scope changes, not daily progress.
