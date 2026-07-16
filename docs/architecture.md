# Inbox Clinic — Architecture Specification

## Document Purpose

This is the **durable, technology-agnostic** specification for Inbox Clinic. It
defines the **principles**, **constraints**, and **stable interfaces** that the
system is built around — the things that should not change easily.

It deliberately **avoids specific technology choices, libraries, exact algorithm
constants, and other movable decisions** (except to note a *constraint* where a
choice is genuinely forced). Those live in the **design documents**
(`design-*.md`), which choose technologies and implement the interfaces
defined here.

| Layer | Owns | Changes |
|-------|------|---------|
| **Architecture** (this doc) | Principles, constraints, stable interfaces & contracts | Rarely — changes are significant |
| **Design docs** | Technology choices, implementation of the interfaces, tunable constants | Freely — as Alpha iterates |

> Background and the decision trail for the client-only model are in
> [descope-plan.md](descope-plan.md).

---

## 1. Vision & Principles

**Vision.** Help individuals regain control of their inbox by analysing email
patterns, surfacing the senders that matter, and making trust decisions easy —
without the service ever seeing their email or holding their credentials.

| Principle | Meaning |
|-----------|---------|
| **Privacy by construction** | The user's email data and credentials never leave their device. This is guaranteed by *where the software runs*, not by policy. |
| **Local-first** | The user's data lives on their device; the app owns its own state and is useful offline. |
| **Delegate enforcement** | Continuous email handling is delegated to the email provider's own rules, so it keeps working when the app is closed. |
| **Minimal operational surface** | The service runs no application servers and stores no user data; a solo maintainer can sustain it indefinitely at negligible cost. |
| **No lock-in** | Favour portable, replaceable choices; avoid corners that are hard to back out of. |
| **Use the ecosystem** | Prefer well-supported, replaceable libraries when they give substantive benefit at acceptable risk and lock-in; don't hand-roll what a stable library does well. |
| **User-controlled** | Optional behaviour is the user's choice, made and stored on their device — not configured per-user by the maintainer. |
| **Mobile-ready** | The system is structured so additional clients (e.g. mobile) can reuse the core without re-architecting. |

---

## 2. Constraints

These are fixed boundaries within which the design operates.

| Constraint | Value |
|------------|-------|
| Email provider | Gmail / Google Workspace only. The system depends on the provider's API, OAuth, and native filtering. |
| Maintainer | Solo, part-time, open-source. |
| Operating model | **Client-only**: no application backend or database in v1. |
| Credentials | **No custody** — the service never persists user credentials. |
| Access | Small, invitation-style user base, gated by the provider's allowlist; self-hosting supported. |
| Funding | Optional donations only; no billing, tiers, or paid features. |
| Licence | Apache-2.0. |
| Maturity | **Alpha** — breaking changes permitted in favour of iteration. |

---

## 3. System Model

Conceptually, Inbox Clinic is a **client application that runs on the user's
device** and talks **directly to the email provider**. It holds the user's data
locally and delegates ongoing enforcement to the provider.

```
        ┌──────────────── User's device ────────────────┐
        │  Inbox Clinic client                           │
        │   • product core (provider-agnostic logic)     │
        │   • on-device persistent store (all user data) │
        │   • user interface                             │
        └───────────────────────┬────────────────────────┘
                                 │ direct, authenticated calls
                                 ▼
        ┌──────────────── Email provider ────────────────┐
        │  • account API (read metadata, modify, settings)│
        │  • native filtering rules ◀── compiled from     │
        │      the user's decisions; enforced continuously │
        │      by the provider, even when the app is closed│
        └─────────────────────────────────────────────────┘

  The service operates no application servers and stores no user data (v1).
```

**Primary flows (conceptual):**

- **Onboard & analyse** — the user authorises access; the client reads recent inbox
  *metadata*, identifies unique senders and domains, and produces prioritised
  decision prompts, all stored on-device.
- **Decide & enforce** — the user trusts/blocks/defers a sender or domain; the
  client records the decision locally and compiles it into the provider's native
  filtering rules, which the provider then enforces.
- **Keep current** — periodically (and on demand) the client reconciles against the
  provider for new messages and re-affirms enforcement. There is no provider-push
  pipeline into a server, because there is no server.

---

## 4. Trust-Decision Model

This is the core domain model and a **stable interface** — the *shape* endures even
as the scoring details are tuned in design.

- **Subjects.** Email is attributed to **senders**, aggregated into **domains**.
- **Decisions.** Each subject may carry a decision: **trust**, **block**, or
  **defer**. Decisions are **persistent** until changed. A **domain decision
  overrides** an address decision; an address may be recorded as an explicit
  exception to its domain.
- **Prompts.** Undecided subjects are surfaced as **prompts**, ordered by a
  **priority** so the highest-impact decisions come first. Prompts **expire** if
  left undecided.
- **Trust signals.** A subject's trustworthiness is derived from three **categories**
  of signal — these categories are stable; their weighting and exact values are an
  implementation decision (design):
  1. **User-behaviour** signals (how this user has engaged with the sender).
  2. **Provider/authentication** signals (delivery authentication and unsubscribe
     compliance reported by the provider).
  3. **Anonymous cross-user** signals — *deferred* (Section 9); the model accommodates
     them without change when introduced.
- **Enforcement.** A decision is realised by compiling it into the provider's
  **native filtering rules**, which the provider enforces continuously and
  independently of the app. The app records the decision as the source of truth and
  reconciles the provider's rules toward it.

---

## 5. Data & Privacy Boundaries

### Entities (conceptual)

The data model comprises: a **profile**, **senders**, **domains**, decision
**prompts**, **analytics** summaries, and user **settings**. Their fields and
on-device representation are a design concern; the **invariants** are architectural:
decisions are persistent and per-subject; domain overrides address; prompts expire;
trust history per subject is bounded.

### Privacy contract (stable)

Each class of data has an **allowed location**, enforced by where the software runs:

| Data | Allowed location |
|------|------------------|
| Inbox metadata, senders, decisions, analytics | **The user's device only.** |
| Email message bodies / contents | **Never read or stored** (metadata only). |
| User credentials | **Never persisted by the service** (short-lived, held only in memory while active). |
| Anonymous aggregate signal (deferred) | Leaves the device **only if the user opts in**, contributed one-way and non-identifiably. |
| Opt-in diagnostic report | Leaves the device **only when the user explicitly submits one**, after **on-screen review** of a **redacted** payload. Carries no message content, credentials, or the user's address. |

**Durability.** Because the user's data lives on their device, the app treats local
persistence as durable but evictable. Most data is reconstructible by re-analysing
the inbox; the exception is **user-generated decisions**, which are not — so
**export and backup of the user's own data are first-class capabilities** (the
mechanism is a design choice).

---

## 6. Core Interfaces

The product logic is a **provider- and UI-agnostic core** that depends only on a
small set of **interfaces (ports)**. Concrete clients, storage, and provider access
are **adapters** behind these interfaces — which is what keeps the system portable
(another UI, or an additional client such as mobile, reuses the same core). These
interfaces are designed **not to change easily**; their implementations are design
decisions.

| Interface | Responsibility | Stability note |
|-----------|----------------|----------------|
| **Provider client** | Authenticate (short-lived, no custody); read inbox metadata; apply actions; reconcile native filtering rules. | Provider-shaped but provider-agnostic in form. |
| **Store** | Persist and query the user's data on-device; **export**, **import** (restore), and **wipe** it. | The contract is stable; the storage technology is not. |
| **Scoring & prioritisation** | Pure, deterministic functions: subject → trust score; set of subjects → ordered prompts. No I/O. | Signatures stable; constants tunable in design. |
| **Aggregate contribution** *(deferred)* | One-way, anonymous, opt-out submission of a subject signal. | Defined now; no implementation in v1. |
| **Reporting client** | One-way submission of an opt-in, redacted diagnostic report. | Cloud-neutral; adapter is a design choice. |

Authorisation follows a **least-permission** principle: the app requests the minimum
provider permission for what the user is doing, escalating only as features require
(read-only to analyse; modify/settings to enforce; contacts and backup only as
opt-in features). The exact permission scopes are a design detail.

---

## 7. Access, Openness & Funding

- **Access** is limited to a small user base gated by the **provider's allowlist**
  (a constraint that naturally keeps the project "small" and avoids heavyweight
  provider verification). A request-access path lets interested people ask to be
  added; **self-hosting** (a user running their own instance) is always supported.
- **Open-source**, in a single public repository, **reproducible by anyone**.
- **No secrets** live in the repository or in the running client.
- **Funding** is optional donations only.

*How* each of these is realised — hosting, the request-access form, sponsorship, CI,
and credential-free deployment — is a design/operations choice, not architecture.

---

## 8. User Settings & Opt-in Features

Inbox Clinic has **no feature-flag system** and no maintainer-controlled per-user
enablement — neither is meaningful in a client-only, open-source app with no backend
or telemetry. Every capability is one of two kinds:

- **Always-on** — enabled for everyone.
- **Opt-in / opt-out** — a toggle the **user** controls, stored on their device.

Examples include the deferred collective-intelligence contribution (opt-out, default
on when it exists) and on-device backup (opt-in). Work-in-progress is simply not
shipped until ready, or released as a clearly-labelled opt-in.

---

## 9. Deferred Capabilities & Seams

Each deferred capability has a **named interface** (Section 6) so it can be added
later as an extension rather than a rewrite.

| Deferred | Seam | Why deferred |
|----------|------|--------------|
| **Collective trust intelligence** | Aggregate-contribution interface; anonymous, one-way, opt-out. | Only valuable at scale; needs no backend in v1. |
| **Aggregate backend & datastore** | Behind the contribution interface. | Choose technology when actually building it; keep the client cloud-neutral. |
| **Additional clients (e.g. mobile)** | Provider-client, store, and scoring interfaces are reused by a new UI adapter. | Avoids a second codebase until warranted. |
| **Server-side real-time handling** | — | Would reintroduce a backend *and* credential custody; deliberately avoided. Native provider filtering covers continuous enforcement instead. |

---

## Appendix A — Glossary

| Term | Meaning |
|------|---------|
| **Subject** | A sender or domain that a trust decision applies to. |
| **Prompt** | An undecided subject surfaced for a trust/block/defer decision. |
| **Decision scope** | Whether a decision applies to an address or a whole domain (domain overrides address). |
| **Native filtering rules** | The provider's own server-side rules, compiled from decisions and enforced independently of the app. |
| **Port / adapter** | A stable interface (port) and its replaceable implementation (adapter). |
| **Contribution interface** | The seam through which decisions could feed a future anonymous aggregate. |

## Appendix B — Changelog

| Version | Date | Change |
|---------|------|--------|
| 3.2 | 2026-07-16 | §1: add the **"Use the ecosystem"** principle — prefer well-supported, replaceable libraries that give substantive benefit at acceptable risk/lock-in over hand-rolling; complements **No lock-in**. |
| 3.1 | 2026-07-05 | §5: add a **second opt-in egress class** — *opt-in diagnostic report* (user-submitted, on-screen-reviewed, redacted; no content/credentials/address) alongside the deferred anonymous aggregate. §6: add the **Reporting client** interface (one-way, cloud-neutral). See [design-error-reporting.md](design-error-reporting.md). |
| 3.0 | 2026-06-28 | Re-levelled to a **technology-agnostic** spec — principles, constraints, and stable interfaces only. Moved technology choices, implementation detail, and algorithm constants to the design docs. |
| 2.0 | 2026-06-28 | Rewrote for the solo, client-only local-first PWA model (superseded the hybrid-cloud commercial spec). |
| 1.x | (prior) | Hybrid GCP + home-Kubernetes commercial architecture (superseded). |
