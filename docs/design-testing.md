# Design: Testing

> **Status:** Draft (Alpha)
>
> **Last Updated:** 2026-07-05

## Overview

This design document establishes testing conventions for Inbox Clinic in its
**client-only, local-first, all-TypeScript PWA** architecture. There is **no
backend**, so testing is **entirely TypeScript** on a single toolchain (Vitest for
test running, with the same lint/format/typecheck/test pipeline used everywhere).

It owns **test structure, mocking patterns, and fixture conventions**. It defines three
test tiers (core unit, web component/integration, and end-to-end), a mocked Google-API
boundary, fixture builders, and the coverage gate.

**Goals:**

- Prioritise fast, deterministic **`packages/core`** unit tests (the logic a future
  mobile client will reuse).
- Test `apps/web` components and the decision workflow against **mocked Google APIs**
  and an in-memory IndexedDB.
- Never hit real Google services; keep tests offline and reproducible.

**Out of scope:**

- CI/CD workflow wiring (see `.github/workflows/` and the build/deploy posture in
  [design-deployment.md](design-deployment.md)).
- Build/bundling configuration (Vite) beyond what tests require.

## Architecture Reference

This design implements the following sections of [architecture.md](architecture.md):

> **Keep It DRY:** Link to architecture.md for the trust-decision *model* and the
> *interfaces*. The concrete scoring, prioritisation, filter, and data-model details
> live in the sibling design docs (`design-*.md`); tests assert against those, they
> are not redefined here.

| Section | Title | Relevance |
|---------|-------|-----------|
| 4 | Trust-Decision Model | Scoring, prioritisation, and the decision workflow under test |
| 6 | Core Interfaces | The provider-client and store ports tests mock (scan, filters, People API, in-memory store) |

## What's Gone (Migration from the Server Era)

The previous design tested a Python + GCP backend. **All of the following are
removed** and replaced by mocked-boundary TypeScript tests:

| Removed | Replaced by |
|---------|-------------|
| Python / **pytest**, `pytest-asyncio`, `pytest-mock`, `responses` | Vitest (TS only) |
| **Firestore / Pub/Sub emulators** and `docker-compose.test.yml` | `fake-indexeddb` (in-memory Dexie); no containers |
| **Integration tests against emulators** | `apps/web` component/integration tests with mocked Gmail + in-memory store |
| **Contract tests** (API/Pub/Sub/Firestore schemas) | Type-level guarantees + `packages/core` unit tests; no network contracts to verify |
| **E2E against real cloud** + dedicated Gmail account, OAuth refresh tokens, CI secrets | Mocked `GmailClient` port with fixture inboxes; nothing reaches Google |
| **k6 load/performance, soak/stress** server tests | Not applicable — no servers. Frontend perf is a Lighthouse/manual concern, not part of this doc |
| Cloud KMS mock, FastAPI test-app pattern | Not applicable — no server crypto, no HTTP app |

See [design-gmail-integration.md](design-gmail-integration.md) for why polling +
client-side sync replaced the Watch/Pub/Sub pipeline.

## Design Decisions

### Decision 1: One TypeScript Toolchain, Vitest as the Runner

**Context:** The codebase is all TypeScript in a monorepo (`apps/web`,
`packages/core`). There is no second language to test.

**Decision:** Use **Vitest** for both tiers. Component tests run under a DOM
environment (**jsdom**, or **happy-dom** where faster); pure-logic tests run with the
default `node` environment (no DOM). Lint/format/typecheck/test share one toolchain.

**Rationale:** Vitest is Vite-native (matches the app's build), fast, ESM-first, and
gives one config story across packages. A single toolchain suits a solo maintainer
(architecture.md §2).

**Alternatives considered:**
- Jest: rejected — extra config to align with Vite/ESM; Vitest is the natural fit.
- Playwright/Cypress E2E against **real Google**: rejected — non-deterministic, needs
  credentials, contradicts the offline-test principle. (Playwright *is* adopted for Tier 3,
  but it drives the offline **demo build** — no Google, no network; see Decision 7.)

### Decision 2: Three Test Tiers

**Context:** Core logic is reused by a future mobile client; UI is web-specific.
Keeping them separate keeps the reusable logic fast and DOM-free. Above them, a thin
end-to-end tier verifies the whole app actually runs in real browsers.

**Decision:**

| Tier | Location | Environment | What it covers | Boundaries |
|------|----------|-------------|----------------|-----------|
| **1. Core unit (priority)** | `packages/core` | `node` (no DOM, no network) | Trust scoring, prompt prioritisation, native-filter compilation, sender/domain extraction, the **store repository** | Pure functions + ports; fully deterministic |
| **2. Web component/integration** | `apps/web` | jsdom/happy-dom | React components and the **trust-decision workflow** (Discovery → Decision → Review → Execution) | Mocked `GmailClient`; in-memory IndexedDB via `fake-indexeddb` |
| **3. End-to-end (Playwright)** | `apps/web/e2e` | real browsers (chromium, firefox, webkit, mobile viewport) | The built app driven through **demo mode**: full workflow, backup/restore, layout switch, theming | The **demo build** — in-memory store + demo `GmailClient`/backup; **no Google, no network** (Decision 7) |

**Rationale:** Tier 1 is the priority because it is portable and where the product's
correctness lives (architecture.md §6). Tier 2 verifies wiring and UX against
realistic-but-fake data. Tier 3 is a thin, high-value smoke tier that catches
integration/rendering regressions the jsdom tiers can't (real layout, service worker,
cross-browser) without ever touching Google.

### Decision 3: Mock Google at the `GmailClient` Port

**Context:** The app talks **only** to Google APIs (Gmail, People), directly from the
browser (architecture.md §3). Tests must never make real calls.

**Decision:** Mock at the **boundary** — the `GmailClient` (and People-API) **port**
defined in `packages/core`. Two mechanisms, by tier:

- **Tier 1:** hand-rolled **fake adapters** implementing the port interface, seeded
  with fixture inboxes/senders. No HTTP involved.
- **Tier 2:** either inject the same fake adapter, or intercept HTTP with **MSW** when
  a test needs to exercise the real fetch/transport path (e.g. token-expiry → re-auth,
  `404` stale-`historyId` rescan, quota/`429` back-off).

Never instantiate a real Google client in any test; never read network credentials.

**Rationale:** Mocking at the port keeps tests deterministic and decoupled from
Google's wire format, while MSW remains available for the few transport-level paths
that matter. Matches architecture.md §6.

**Alternatives considered:**
- Mock `fetch` ad hoc per test: rejected — leaks Google's wire shape into many tests.
- Record/replay real responses: rejected — stale fixtures, needs real credentials to refresh.

### Decision 4: In-Memory IndexedDB for the Store

**Context:** The store repository is Dexie over IndexedDB (architecture.md §5),
and is part of Tier 1 (the repository) and Tier 2 (workflow persistence).

**Decision:** Use **`fake-indexeddb`** to provide an in-memory IndexedDB. Each test
gets a fresh database (new instance / `beforeEach` reset) for isolation. Repository
tests assert against the public repository interface, not raw object stores.

**Rationale:** Exercises real Dexie behaviour (indexes, transactions, keys) without a
browser, fast and deterministic.

### Decision 5: Fixture Builders Over Inline Data

**Context:** Tests need valid senders, domains, prompts, and inboxes matching the
Section 5 schema and the Section 4 scoring inputs.

**Decision:** Provide **typed builder functions** with sensible defaults and
overrides. Builders return the domain types from `packages/core`, so schema drift is
a compile error.

```typescript
// packages/core/src/testing/builders.ts
export function senderBuilder(overrides: Partial<Sender> = {}): Sender {
  return {
    email: "news@example.com",
    domain: "example.com",
    category: "promotional",
    trustStatus: "pending",
    totalEmails: 12,
    emails30d: 4,
    readRate: 0.25,
    replyCount: 0,
    starredCount: 0,
    spamMarkedCount: 0,
    inContacts: false,
    trustHistory: [],
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}
```

Companion builders: `domainBuilder`, `promptBuilder`, and an **`inboxBuilder`** that
emits Gmail-metadata-shaped messages/headers to seed the fake `GmailClient`.

**Rationale:** Typed builders give valid-by-default data with per-test overrides and
catch schema drift at compile time. A library (e.g. fishery) is unnecessary at this
scale.

### Decision 6: Coverage Gate Focused on `packages/core`

**Context:** A coverage gate focused on core logic is retained from the prior design.

**Decision:** Enforce **≥80%** coverage (lines/branches/functions/statements) on
**`packages/core`** via Vitest's V8 coverage provider. `apps/web` is measured and
reported but the **blocking gate is on core**; UI thresholds may be lower and are an
Open Question.

**Exclusions** require a documented rationale, mirroring the prior policy in TS form:

```typescript
/* v8 ignore next */ // RATIONALE: defensive branch unreachable per the type system
if (x === undefined) throw new Error("unreachable");
```

Type-only constructs (`import type`, interfaces) are not counted as executable. The
pre-push / CI check fails if core coverage drops below 80% or an exclusion lacks a
`// RATIONALE:`.

**Rationale:** Concentrates the gate on the portable, high-value logic; avoids
brittle coverage targets on presentational React.

### Decision 7: End-to-End Tier via Playwright against demo mode

**Context:** The whole signed-in product (shell, dashboard, four-phase workflow,
analytics, backup/restore) is only reachable after a real Google OAuth sign-in. The
jsdom tiers verify component wiring but never run the built app in a real browser, so
real-layout, service-worker, and cross-browser regressions can slip through. We want
end-to-end coverage **without** the non-determinism of real Google.

**Decision:** Ship a **demo mode** — a no-Google, fully in-memory build path (an
`?demo` entry, a demo `GmailClient`/backup, and an in-memory store seeded with curated
fixtures) — and run **Playwright** against it. The demo fixtures and in-memory engines
are **production-shippable** and live in **`@inboxclinic/core/demo`** (distinct from the
test-only `@inboxclinic/core/testing`; the two share private in-memory engines so nothing
is duplicated and no test code ships).

- **Browsers:** chromium, firefox, webkit, plus a mobile-viewport project (both shells).
- **CI:** a **required** gate (`.github/workflows/e2e.yml`) — build, install browsers,
  run against `vite preview`; upload the HTML report + traces on failure.
- **Determinism:** demo mode makes **zero network calls**; the store is ephemeral and
  re-seeded per run, so E2E is as reproducible as the unit tiers.

**Rationale:** Demo mode is independently valuable (anyone can explore the product with
no account), and reusing it as the E2E substrate keeps end-to-end tests offline and
deterministic — honouring Decision 1's rejection of E2E against *real* Google while still
getting real-browser coverage.

**Alternatives considered:**
- E2E against a mocked network layer (MSW) instead of demo mode: rejected — demo mode is
  a real product feature we want anyway, and driving it avoids maintaining a parallel
  transport-level mock.
- Component-tier only (no Playwright): rejected — never exercises real layout/SW/browsers.

### Decision 8: Property-Based Tests for Pure-Core Invariants

**Context:** Example tests spot-check specific inputs, but `packages/core` is pure logic
with **invariants** (precedence laws, idempotence, coverage, chunk stability) that a
handful of hand-picked cases can't exercise across the edge space — exactly where bugs
recur (chunk-boundary churn, effective-status precedence, exception carve-outs).

**Decision:** Use **fast-check** (a dev dependency, run under Vitest) to assert **laws**
over randomized inputs, alongside the example tests — not replacing them. Property files
are co-located as `*.property.test.ts`. Reach for a property test when a Tier-1 function
has an invariant that should hold for **all** inputs — *"is total / never throws"*,
*"reconcile after apply is a no-op"*, *"every domain covered exactly once"*, *"a domain
decision overrides a non-exception address"*. Keep example tests for specific,
human-meaningful scenarios and regressions.

- **Reproducibility:** pin a **seed** on non-trivial generators (fast-check prints the
  failing seed + shrunk counterexample on failure), so CI is deterministic.
- **Probabilistic invariants** (e.g. content-defined chunk locality, #152) assert a
  **generous bound/fraction** that decisively separates correct from broken behaviour,
  not a brittle exact constant.
**Rationale:** Property tests turn the "invariant" comments scattered through the compiler
and decision logic into executed guarantees, at near-zero example-writing cost, while
staying inside the one-toolchain (Decision 1) offline-and-deterministic model.

#### Fuzzing untrusted-input boundaries (#166)

The same fast-check driver fuzzes the seams where the app ingests data it doesn't control —
asserting **"no uncaught throw + valid output shape + privacy invariant intact"** rather than
an exact value, over `fc.uint8Array`/`fc.json`/`fc.anything` plus a hand-picked hostile corpus.
Fuzz files are co-located as `*.fuzz.test.ts` (or a `fuzzing` describe block). Boundaries covered:

- **Gmail-response parsing** — `parseHeaders` (`BrowserGmailClient`) and `parseFromHeader` /
  `parseAuthResults` / `extractSenders` (`packages/core`): garbage headers never throw and only
  ever emit **allowlisted, string-valued metadata** — never a message body (privacy).
- **Restore/import** — `parseStoreDump` is the single pure gate both `Store.importAll`
  implementations run **before** any wipe/write, so a malformed blob throws a typed
  `InvalidBackupError` and **leaves the store unchanged** (no partial write), never a raw
  `SyntaxError`/`TypeError`.

To add a case: extend the relevant `*.fuzz.test.ts` — a new arbitrary, or a hostile literal in
the corpus. A crash found by fuzzing is fixed (or filed) and its reproducing input added to the
corpus. Validation is **shape/safety**, not schema enforcement (a restore is the user's own
data; deep per-field checks are the migration layer's job).

## Interfaces

### Test File Layout

Tests are **co-located** with source as `*.test.ts(x)` (property-based ones as
`*.property.test.ts`). Shared fixtures/builders live under a `testing/` folder per package
and are importable across tiers.

```
packages/core/
├── src/
│   ├── scoring/
│   │   ├── trustScore.ts
│   │   └── trustScore.test.ts
│   ├── prioritisation/
│   │   └── promptPriority.test.ts
│   ├── filters/
│   │   └── compileFilters.test.ts
│   ├── store/
│   │   └── repository.test.ts        # exercised with fake-indexeddb
│   ├── ports/
│   │   └── GmailClient.ts            # the boundary tests mock
│   ├── testing/                      # test-only fakes/builders (@inboxclinic/core/testing)
│   │   ├── builders.ts              # senderBuilder, domainBuilder, messageMetaBuilder
│   │   └── MockGmailClient.ts       # in-memory GmailClient adapter (with spies)
│   └── demo/                         # shippable demo engine + fixtures (@inboxclinic/core/demo)
│       ├── demoData.ts              # curated senders/inbox/history fixtures
│       └── seedDemoStore.ts         # populate an in-memory store for demo mode
│
apps/web/
├── src/
│   ├── components/
│   │   ├── SenderCard.tsx
│   │   └── SenderCard.test.tsx
│   └── workflow/
│       └── decisionWorkflow.test.tsx  # Discovery → Decision → Review → Execution
├── src/testing/
│   └── setup.ts                      # jsdom + fake-indexeddb lifecycle
├── e2e/                              # Tier 3 — Playwright specs, run against the demo build
│   ├── workflow.spec.ts
│   ├── backup-restore.spec.ts
│   └── layout.spec.ts
└── vitest.config.ts
```

A `__tests__/` directory is acceptable for groups of cross-cutting tests, but
co-location is the default.

### Naming Conventions

| Element | Convention | Example |
|---------|------------|---------|
| Test files | `{module}.test.ts(x)` | `trustScore.test.ts`, `SenderCard.test.tsx` |
| Top-level `describe` | the unit under test | `describe("compileFilters", …)` |
| `it`/`test` | `it("<does X> when <context>")` | `it("prefers a domain filter when 3+ senders blocked")` |
| Builders | `{entity}Builder` | `senderBuilder`, `inboxBuilder` |
| Fakes | `fake{Service}` / `Fake{Service}` | `fakeGmailClient` |

### `GmailClient` Mock (the boundary)

The fake implements the same port the production adapter does; tests configure
responses and error conditions.

```typescript
export interface GmailClientFake extends GmailClient {
  seedInbox(messages: GmailMessageMeta[]): void;   // metadata-only headers/labels
  setHistoryStale(): void;                           // force 404 → bounded rescan path
  setRateLimited(afterCalls?: number): void;         // 429 back-off path
  setAuthExpired(): void;                             // token-expiry → re-consent path
  createdFilters(): CompiledFilter[];                // assert filter sync
}
```

People-API contact look-ups are mocked on the same fake (`setInContacts(email)`),
honouring the 24-hour TTL behaviour from [design-gmail-integration.md](design-gmail-integration.md).

## Configuration

`vitest.config.ts` lives per package (workspace at the repo root). Key conventions:

| Setting | Value | Notes |
|---------|-------|-------|
| `test.environment` | `node` (core) / `jsdom` or `happy-dom` (web) | Per-package |
| `test.setupFiles` | `src/testing/setup.ts` (web) | Installs `fake-indexeddb/auto`, starts/stops MSW |
| `test.coverage.provider` | `v8` | — |
| `test.coverage.thresholds` | `80` lines/branches/functions/statements on `packages/core` | Blocking gate (Decision 6) |
| `test.globals` | `true` | `describe`/`it`/`expect` without imports |

There are **no test environment variables for cloud services** (no
`FIRESTORE_EMULATOR_HOST`, no `PUBSUB_EMULATOR_HOST`, no GCP project). The OAuth
client id used in any transport test is a **public, fake** value.

## Error Handling

Tests must cover the client-side failure paths from [design-gmail-integration.md](design-gmail-integration.md):

| Path | Test strategy |
|------|---------------|
| Token expiry | `setAuthExpired()` → assert re-consent is triggered, no crash |
| Stale `historyId` (`404`) | `setHistoryStale()` → assert transparent bounded rescan + marker reset |
| Quota / `429` | `setRateLimited()` → assert slow/pause + user warning near cap |
| Filter limit (≤10/OR, soft cap 450) | seed many blocks → assert domain-level + combined filters (see [design-gmail-integration.md](design-gmail-integration.md)) |
| Partial filter sync failure | assert idempotent retry; local decision remains source of truth |

## Examples

### Example 1: Core unit test (no DOM, deterministic)

```typescript
import { computeTrustScore } from "./trustScore";
import { senderBuilder } from "../testing/builders";

describe("computeTrustScore (v1, no network signal)", () => {
  it("weights User and Compliance per the re-normalised split", () => {
    const sender = senderBuilder({ replyCount: 2, inContacts: true });
    // Asserts against the v1 weighting in design-trust-decisions.md — values defined there.
    expect(computeTrustScore(sender)).toBeGreaterThan(3);
  });
});
```

### Example 2: Native-filter compilation

```typescript
it("prefers a domain filter when 3+ senders from one domain are blocked", () => {
  const senders = ["a", "b", "c"].map((u) =>
    senderBuilder({ email: `${u}@spam.com`, domain: "spam.com", trustStatus: "blocked" }),
  );
  const filters = compileFilters(senders);
  expect(filters).toContainEqual(expect.objectContaining({ from: "*@spam.com" }));
});
```

### Example 3: Workflow integration (mocked Gmail + in-memory store)

```typescript
it("applies a block decision and records a compiled filter", async () => {
  const gmail = new GmailClientFake();
  gmail.seedInbox(inboxBuilder({ from: "news@promo.com", count: 120 }));

  render(<DecisionWorkflow gmail={gmail} />);
  await userEvent.click(await screen.findByRole("button", { name: /block/i }));
  await userEvent.click(screen.getByRole("button", { name: /apply/i }));

  await screen.findByText(/done/i);
  expect(gmail.createdFilters()).toHaveLength(1);
});
```

## Open Questions

- [x] **PWA / service-worker & offline behaviour.** Resolved: cache/sync **logic** is
      unit-tested in `packages/core` (pure, Tier 1) behind a platform interface, and
      service-worker registration / real-browser behaviour is exercised by the **Tier 3
      Playwright** suite (Decision 7) against the demo build. `@vitest/web-worker` /
      Workbox test helpers are not needed.
- [ ] **`apps/web` coverage threshold.** Core is gated at ≥80%; what (if any) blocking
      threshold applies to UI? Default: report-only until the UI stabilises.
- [ ] **Fixture realism.** Do we snapshot a small set of anonymised real Gmail
      metadata shapes into `inboxBuilder`, or keep everything synthetic? Default: synthetic.

---

**Changelog:**

| Date | Change | Author |
|------|--------|--------|
| 2026-06-28 | Rewritten for the client-only, all-TypeScript PWA architecture: Vitest two-tier model (`packages/core` pure + `apps/web` component/integration), `GmailClient`-boundary mocking, `fake-indexeddb`, typed fixture builders, core-focused ≥80% coverage gate. Removed Python/pytest, emulators, contract and cloud-E2E/k6 testing. | Claude |
| 2026-07-05 | Add **Decision 7 & a third test tier: end-to-end (Playwright) against demo mode** — a shippable no-Google demo build (`@inboxclinic/core/demo`) driven by Playwright across chromium/firefox/webkit + mobile, as a required CI gate. Reframed Decision 2 to three tiers; resolved the PWA/service-worker Open Question via Tier 3; corrected the Test File Layout (`demo/`, `e2e/`; dropped the never-adopted MSW handlers). | Claude |
| 2026-07-18 | Add **Decision 8: property-based tests** (fast-check under Vitest, `*.property.test.ts`) for pure-core invariants — when to reach for them vs example tests, seed/reproducibility, generous bounds for probabilistic invariants; fuzzing of untrusted-input boundaries noted as related (#166). Landed compiler (cap/coverage/idempotence/stability), effective-status precedence, and `keyFor` collision properties (#165). | Claude |
| 2026-07-18 | Add the **Fuzzing** subsection to Decision 8 (#166): `*.fuzz.test.ts` for the Gmail-response parsers (`parseHeaders`, `parseFromHeader`/`parseAuthResults`/`extractSenders` — no throw, allowlisted metadata-only) and the restore/import boundary (`parseStoreDump` — typed `InvalidBackupError`, no partial write). Documents the hostile-corpus approach and shape-vs-schema scope. | Claude |
