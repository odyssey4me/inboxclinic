# Design: Error Reporting & Feedback

> **Status:** Draft (Alpha)
>
> **Last Updated:** 2026-07-05

## Overview

This document designs an **opt-in, anonymous, user-reviewed feedback/error-report** path for
Inbox Clinic, and the **minimal edge backend** that receives it. Today a runtime error (e.g.
a Gmail `429` during a scan) is shown once and lost with the session — there is no way for a
user to send it back to the project.

The design is deliberately scoped as **the first service of the deferred aggregate backend**
([architecture.md](architecture.md) §9): the same edge runtime, anti-abuse middleware, and
cloud-neutral client seam that *Collective trust intelligence* will need are established here
once, for feedback, and reused later for aggregate contribution — **with different identity
handling for each** (see Decision 5).

**Scope:** the client "Report a problem" flow, redaction, the report payload, the edge intake
(→ GitHub issue), abuse controls, the anonymous client identifier, and the proposed
architecture amendment that permits a second (opt-in, reviewed) egress path.

**Out of scope (linked, not duplicated):**
- Aggregate-contribution *content/semantics* — deferred; only its shared infrastructure is set up here (architecture.md §9, [design-trust-decisions.md](design-trust-decisions.md)).
- Transport retry/backoff for Google calls — see [design-gmail-integration.md](design-gmail-integration.md) (already implemented).
- On-device store schema — see [design-local-store-schema.md](design-local-store-schema.md); this adds one field (Decision 5).

## Architecture Reference

| Section | Title | Relevance |
|---------|-------|-----------|
| 5 | Data Ownership & Boundaries | Introduces a **second egress class** (opt-in, redacted, user-reviewed diagnostics) alongside the deferred aggregate — requires the amendment proposed below. |
| 6 | Core Interfaces | Adds a **Reporting client** port (adapter behind it), mirroring `Provider client` / `Store` / `Aggregate contribution`. |
| 7 | Access, Openness & Funding | Reproducible static build; the edge function is optional and cloud-neutral behind the port. |
| 9 | Deferred Capabilities & Seams | This is the **first concrete use** of the edge backend + anti-abuse foundation the aggregate contribution will reuse. |

> **Proposed architecture amendment (needs sign-off — architecture.md is not edited here).**
> §5's data table says the anonymous aggregate is *"the only data that may leave the device."*
> This design adds a second egress. Proposed replacement row + addition:
>
> | Data | Allowed location |
> |------|------------------|
> | Anonymous aggregate signal *(deferred)* | Leaves the device **only on opt-in**, one-way and non-identifiably. |
> | **Opt-in diagnostic report** | Leaves the device **only when the user explicitly submits one**, after **on-screen review** of a **redacted** payload. Carries no message content, credentials, or address. |
>
> And §6 gains one interface row:
>
> | Interface | Responsibility | Stability note |
> |-----------|----------------|----------------|
> | **Reporting client** | One-way submission of an opt-in, redacted diagnostic report. | Cloud-neutral; adapter is a design choice. |

## Design Decisions

### Decision 1: Opt-in, transparent, user-reviewed — never automatic

**Context:** The app forbids telemetry and silent egress (§5–6). But users hit real errors
with no channel back.

**Decision:** Reporting is **strictly user-initiated**. A "Report a problem" panel assembles
the payload, **renders it verbatim in an editable field**, and sends **only** on an explicit
submit. Nothing is ever transmitted in the background.

**Rationale:** This is the only form of reporting compatible with privacy-by-construction:
consent is explicit and the user sees exactly what leaves the device. "Shows what it's
posting" is a hard requirement, not a courtesy.

**Alternatives considered:**
- *Automatic crash telemetry (Sentry-style):* violates §5–6; no consent, opaque payload. Rejected.

### Decision 2: Deliver as a GitHub issue via a Cloudflare edge function

**Context:** The repo is **public** with issues enabled; the app already deploys to
**Cloudflare Pages** (inboxclinic.com). Reports want first-class triage and a link to the
exact commit.

**Decision:** The client POSTs the report to a **Cloudflare Pages Function** (`/api/report`,
same origin — no CORS). The function creates a **GitHub issue** using a **fine-grained PAT**
(issues-write, this repo only) held as a Pages **secret** — so the reporter needs no GitHub
account and stays anonymous (issue authored by the project bot).

**Rationale:** Same infrastructure already in use; issues give dedupe, triage, and
commit-linking; the secret has a tiny blast radius. This is the first module of the planned
aggregate backend (same Workers account/runtime).

**Alternatives considered:**
- *Prefilled Google Form → Sheet:* zero backend, but reports live in a Sheet not issues, prefill length is capped, and it opens a Google page. Kept as the fallback if the edge function is undesired.
- *Edge function → private D1/KV store:* no GitHub token, but you build a viewer; worse triage. Reconsider if reports should stay private.
- *Google Apps Script web app:* Google-hosted endpoint, CORS quirks, opaque. Rejected.

### Decision 3: Redact on-device before the payload is ever shown

**Context:** Error strings leak PII — e.g. `…429 for /messages/19efa38b32b35328?…` embeds a
message id; stacks and messages can carry emails, tokens, subjects.

**Decision:** A **pure redactor** in `packages/core` runs before display and submission,
masking: email addresses → `[email]`, bearer/access tokens → `[token]`, Gmail message/thread
ids in paths → `[id]`, and `subject=`/`Subject:` values → `[subject]`. Header *names* (e.g.
`metadataHeaders=From`) are retained (not sensitive). Redaction is **testable in isolation**
and applied even though the user can still edit the field afterward.

**Rationale:** Defence in depth: the user reviews, but redaction means the default is already
safe, and reports posted to a **public** issue never carry identifiers.

### Decision 4: Report payload — carries the error and the deployed commit

**Context:** Reports must be actionable and tie to "what was live at the time."

**Decision:** The payload is redacted and contains: redacted `message` + `stack`, the
**build commit SHA + build date** (injected at build — see Configuration), coarse environment
(user-agent, current view/action, `online`, layout), and a timestamp. It **never** contains
Gmail content, tokens, or the user's address. See [Interfaces](#interfaces).

### Decision 5: An anonymous install ID for feedback abuse-correlation — distinct from aggregate identity

**Context:** The user wants a client identifier, saved/exported/backed-up, to **track and
deter abuse** of the endpoint.

**Decision:** Mint a random **install ID** (UUID v4) once, stored in the on-device Store so
`exportAll` / Drive backup carry it automatically; echoed on each report. It is **user-
resettable** ("Reset feedback identifier" in Settings; reset = new identity + fresh soft-limit
slate). The raw ID is sent to the edge function over TLS but is **not** placed in the public
issue — the function keeps it server-side (KV) and stamps only a short **one-way hash** (e.g.
`client:9f3a`) for at-a-glance grouping.

**Honest limits (documented, not hidden):** a client-held, user-visible identifier is
**forgeable and rotatable** (edit the field, clear storage, skip the restore). So the install
ID is a **cooperative** signal — good for correlating an honest user's reports and for *soft*
per-ID limits — **not** the enforcement mechanism. Real abuse prevention is server-side (see
Decision 6).

**Critical separation:** this stable, exported ID must **not** be reused as the *aggregate
contributor* identity. Aggregate contribution is defined as "non-identifiable, one-way"
(§5/§9); attaching a stable per-client ID would let contribution patterns be linked and
weaken that guarantee. The two egress paths **share infrastructure but not identity** — the
aggregate path uses no stable ID (or a rotating/blinded token, to be designed with that
feature).

**Alternatives considered:**
- *Server-issued signed token (HMAC) minted on first Turnstile-passed submit:* harder to forge than a self-chosen UUID, but still discardable; extra complexity. Deferred as an optional hardening.

### Decision 6: Real abuse prevention is server-side — Turnstile + rate limiting

**Context:** An anonymous public POST endpoint is a spam/abuse target; the install ID can't
gate it.

**Decision:** The edge function enforces, in order: (1) **Cloudflare Turnstile** token
verification (invisible human-proof, the primary gate); (2) **rate limiting** in Workers KV
keyed on a **truncated hash of the client IP** (short TTL) *and* the install ID (soft limit);
(3) a **payload size cap** and schema validation. Only then is the issue created. The client
IP is never stored raw and never leaves the edge.

**Rationale:** Turnstile + IP rate-limiting are what actually stop floods; the install ID
layers correlation on top. This middleware is the reusable foundation for the aggregate
endpoint.

## Interfaces

### Reporting client port (`packages/core`)

```ts
interface ReportingClient {
  /** Submit an opt-in, redacted diagnostic report. One-way; resolves on accept. */
  submit(report: DiagnosticReport, humanToken: string): Promise<{ ref: string }>;
}
```

### `DiagnosticReport` (client → edge)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes | Redacted error message |
| `stack` | string | No | Redacted stack trace |
| `appVersion` | string | Yes | Build commit SHA (short) |
| `builtAt` | string | Yes | Build date (ISO) |
| `view` | string | No | Current app view/action when captured |
| `userAgent` | string | No | Browser UA string |
| `online` | boolean | No | Navigator online state |
| `installId` | string (uuid) | Yes | Anonymous install ID (Decision 5) — server-side only |
| `note` | string | No | Optional free-text the user adds |

The edge function maps this to a GitHub issue: title from `message`, body = the redacted
fields + `appVersion`/`builtAt` + a `client:<hash>` label. `installId` and IP-derived data
are **not** written to the issue.

## Configuration

### Build-time (client)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VITE_APP_COMMIT` | No | `"dev"` | Short commit SHA injected at build (`GITHUB_SHA` in CI / `git rev-parse --short HEAD` locally). Also shown in the footer. |
| `VITE_APP_BUILT_AT` | No | build time | ISO build date. |
| `VITE_TURNSTILE_SITE_KEY` | No | – | Public Cloudflare Turnstile site key; feedback UI hides submit if unset. |

### Edge function (Cloudflare Pages) — secrets/bindings, never in Git

| Name | Kind | Description |
|------|------|-------------|
| `GITHUB_TOKEN` | secret | Fine-grained PAT, issues-write, this repo only |
| `TURNSTILE_SECRET` | secret | Turnstile server-side verification key |
| `REPORT_KV` | KV binding | Rate-limit counters + install-ID correlation |

### Settings (on-device)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `installId` | uuid | generated | Anonymous feedback identifier (Decision 5); resettable |

## Error Handling

| Error | When | UX |
|-------|------|----|
| Turnstile fails / unavailable | Human-proof not obtained | Block submit; explain; offer **Copy** / **Download `.md`** fallback |
| Rate limited (429 from edge) | Too many reports from IP/ID | Explain the limit and when to retry; keep the report for copy/download |
| Edge/GitHub error (5xx) | Issue creation failed | Surface failure; offer copy/download so the report is never lost |
| Offline | No network | Submit disabled; copy/download still work |

Copy/Download are always available so a report is never lost to a submission failure — and
they are the **no-backend fallback** (Decision 2 alternative).

## Migration Notes

- Adds one on-device field (`installId`); no destructive change (alpha, no back-compat needed).
- Requires the §5/§6 architecture amendment above to be **approved** before implementation.
- The edge function is additive; the static client works unchanged without it (falls back to copy/download).

## Open Questions

- [ ] Should the optional server-signed token (Decision 5 alt) ship in v1, or stay deferred?
- [ ] Should reports also be mirrored to a private store (D1) for triage history, or issues-only?
- [ ] Deployment: the current `wrangler pages deploy apps/web/dist` must include a `functions/` dir — confirm the build wiring in [design-deployment.md](design-deployment.md).
- [ ] Do we want a lightweight in-app "recent errors" ring buffer so non-crash errors (like the 429) are reportable after the fact, or report only the currently-surfaced error?

---

**Changelog:**

| Date | Change | Author |
|------|--------|--------|
| 2026-07-05 | Initial draft — opt-in, anonymous, user-reviewed feedback → GitHub issue via a Cloudflare Pages Function; on-device redaction; anonymous install ID for abuse-correlation (distinct from aggregate identity); Turnstile + KV rate-limiting; proposed §5/§6 architecture amendment for a second (opt-in, reviewed) egress path. Scoped as the first service of the deferred aggregate backend (§9). | Claude |
