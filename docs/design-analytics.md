# Design: Analytics

> **Status:** Draft
>
> **Last Updated:** 2026-07-16

## Overview

This document defines Inbox Clinic's **on-device analytics**: the inbox health score,
the time-saved estimate, category/domain breakdowns, achievements, and the **opt-in
local shareable snapshot**. It owns the **v1 formulas, constants, and thresholds** for
these derived metrics and the rule for which counters must be persisted versus
recomputed.

Everything here is **local-first and metadata-only** (architecture.md §5): analytics
are computed on the user's device from their own data; nothing is sent anywhere. The
shareable snapshot is created locally and shared **only if the user chooses to** —
there is no server, no external analytics, and **no referral/tracking code** (§7).

**Scope:** the analytics maths (pure `packages/core`), where the persisted daily
counters are accumulated, the monthly rollup, and the snapshot artifact.

**Out of scope (linked, not duplicated):**
- Analytics **screen** layout, components, and navigation — see [design-frontend.md](design-frontend.md)
  (the *Analytics* screen row and Decision 5). This doc owns the numbers; that doc owns the UI.
- The on-device store shape (`analyticsDaily`/`analyticsMonthly`) — see [design-local-store-schema.md](design-local-store-schema.md).
- Trust scoring — see [design-trust-decisions.md](design-trust-decisions.md). The health
  score is a separate, coarse inbox-level metric, not the per-sender trust score.

## Architecture Reference

This design implements the following sections of [architecture.md](architecture.md). It
does not restate them; it defines how the analytics realise them.

| Section | Title | Relevance |
|---------|-------|-----------|
| 5 | Data & Privacy Boundaries | Analytics live **on the device only**; metadata-only; the snapshot is the user-controlled artifact, not aggregate contribution |
| 8 | User Settings & Opt-in Features | Sharing a snapshot is a user-initiated, opt-in action with no default egress |

## Design Decisions

### Decision 1: Persist only reconstruction-proof counters; derive the rest on demand

**Context:** §5 notes most data is reconstructible by re-analysing the inbox; the
exception is user-generated history. The same holds for analytics — current totals
(trusted/blocked/pending, per-category volume, top domains) are always recomputable
from the live `senders`/`domains` stores, but *what happened on a given day* is not.

**Decision:** Persist a small set of **daily counters** (`analyticsDaily`) that record
events as they happen; compute every derived metric (health, time-saved, breakdowns,
top domains, achievements) **on demand** from current state plus those counters. The
monthly rollup (`analyticsMonthly`) is a cached fold of the daily counters and is always
recomputable.

**Persisted daily counters** (`DailyAnalytics`), accumulated at these events:

| Counter | Incremented at | Meaning |
|---------|----------------|---------|
| `newSenders` | scan / incremental sync | senders newly discovered that day |
| `decisionsMade` | `applyDecision` | trust/block/defer decisions recorded (one per call) |
| `sendersBlocked` | `applyDecision` | subjects blocked (1 for address; covered members for domain) |
| `sendersTrusted` | `applyDecision` | subjects trusted (same scoping) |
| `emailsBlocked` | `enforce` | existing messages removed from the inbox (archive + trash) |
| `emailsRescued` | `enforce` | messages pulled back out of Spam/Trash (Trust rescue) |

Each event records exactly one disjoint slice, so there is no double counting. Store
writes are a thin read-modify-write (`recordDailyAnalytics`); all maths is in pure
functions.

**Rationale:** Minimises persisted state (cheap, export-friendly, no migration churn),
keeps the metrics honest against the live store, and isolates the only data that *must*
be durable. **Alternatives considered:** persisting full daily snapshots of every total
(redundant with current state, and large); computing health from a history series
(needless — current state already holds it).

### Decision 2: Inbox health score (0–100)

**Decision:** A coarse inbox-level score blending three normalised components:

```
coverage = decided / total          (you have triaged your senders)
hygiene  = blocked / decided        (you have removed noise)
read     = mean read rate           (what reaches you is relevant)

health = round(100 × (0.5·coverage + 0.3·read + 0.2·hygiene))   clamped to 0–100
```

- `decided = trusted + blocked`, `total = trusted + blocked + pending`.
- `read` is the mean `readRate` over senders that have one; when none do, it falls back
  to **0.5** (neutral). With **no senders at all** the score is the neutral **50**.

**Chosen constants:** weights **0.5 / 0.3 / 0.2** (sum to 1), read fallback **0.5**,
empty-inbox neutral **50**. Worked boundaries: all-pending → 15; fully triaged + all
trusted + fully read → 80; fully triaged + all blocked + fully read → 100.

**Rationale:** Rewards triage progress first, then a relevant + clean inbox. Coarse and
explainable; deliberately distinct from per-sender trust scoring (design-trust-decisions.md).

### Decision 3: Estimated time saved

**Decision:** `estimatedTimeSaved(emailsBlocked) = round(emailsBlocked) × 5` **seconds**.
The constant **`SECONDS_PER_BLOCKED_EMAIL = 5`** is a conservative estimate of the
skim-and-dismiss time per email that no longer reaches the inbox. The window's summed
`emailsBlocked` (real messages archived/trashed) is the input.

**Rationale:** Simple, transparent, and tied to a real action (messages actually
removed) rather than a speculative forecast. Tunable in one place if evidence warrants.

### Decision 4: Achievements (rule-based badges, documented thresholds)

**Decision:** Pure predicates over cumulative window stats; each badge is earned or not.

| Id | Name | Threshold |
|----|------|-----------|
| `first-block` | First Block | `sendersBlocked ≥ 1` |
| `trust-builder` | Trust Builder | `sendersTrusted ≥ 10` |
| `clean-sweep` | Clean Sweep | `sendersBlocked ≥ 10` |
| `triage-master` | Triage Master | `decisionsMade ≥ 50` |
| `time-saver` | Time Saver | `estimatedTimeSavedSeconds ≥ 3600` (one hour) |
| `inbox-hero` | Inbox Hero | `inboxHealthScore ≥ 80` |

**Rationale:** Lightweight, deterministic encouragement; no streak/time state to persist.

### Decision 5: Privacy-safe shareable snapshot

**Context:** §7's opt-in local shareable snapshot must leak nothing and carry no
referral/tracking code.

**Decision:** `buildSnapshot(summary)` produces a self-contained object of **aggregate
numbers only** — health score, time saved, blocked/trusted/pending counts, blocked-email
volume, per-category counts, and earned achievement names. It **excludes every
identifier** (no sender addresses, no domain names, no message content). The user
exports it as a **shareable PNG image** (the primary share form, rendered on-device from
the aggregate numbers), with the JSON / plain-text summary (`snapshotText`) available for
data/portability; all are produced on-device, and sharing is an explicit user action with no
automatic egress.

**Rationale:** Lets users share progress without exposing who emails them; the exclusion
of domains/addresses is enforced in the pure builder and covered by a test.

## Interfaces

All exported from `@inboxclinic/core` (pure unless noted).

```ts
// metrics.ts — pure
inboxHealthScore(input: InboxHealthInput): number;           // 0–100
healthInputFromSenders(senders: Sender[]): InboxHealthInput;
estimatedTimeSaved(emailsBlocked: number): number;           // seconds
categoryBreakdown(senders: Sender[]): CategoryStat[];        // volume desc
topDomainsByVolume(domains, limit, { status? }): DomainVolume[];
achievements(input: AchievementInput): Achievement[];

// record.ts — thin over the Store port
dateKey(now): string;  monthKey(now): string;  emptyDaily(date): DailyAnalytics;
recordDailyAnalytics(store, now, delta: DailyDelta): Promise<void>;

// summary.ts
buildAnalyticsSummary(input): AnalyticsSummary;              // pure fold
buildMonthlyAnalytics(now, days, summary): MonthlyAnalytics; // pure rollup
analyticsSummary(store, { now?, windowDays? }): Promise<AnalyticsSummary>; // reads store, persists month
buildSnapshot(summary): AnalyticsSnapshot;                   // pure, identifier-free
snapshotText(snapshot): string;                              // pure
```

`AnalyticsStore` gains `recentDays(limit)` (most-recent-first) so the window rollup
reads only what it needs. See [design-local-store-schema.md](design-local-store-schema.md)
for the store contract and [design-frontend.md](design-frontend.md) for the screen.

## Error Handling

Analytics are pure, local reads; there is no network and no app API to fail. A missing
day record reads as absent (treated as zero); an empty store yields the neutral score
and empty breakdowns. Snapshot export uses a local `Blob` download; copy-to-clipboard
falls back to showing the text inline if the Clipboard API is unavailable.

## Examples

### Recording an event (thin store write)

```ts
// enforce.ts, after applying message actions
await recordDailyAnalytics(store, now, {
  emailsBlocked: messagesArchived + messagesTrashed,
  emailsRescued: messagesRescued,
});
```

### Loading the summary for the Analytics screen

```ts
const summary = await analyticsSummary(store, { now: Date.now() }); // windowDays = 30
// summary.inboxHealthScore, summary.window.*, summary.categories, summary.achievements …
```

## Migration Notes

`DailyAnalytics`/`MonthlyAnalytics` move from placeholder shapes to the counter/rollup
shapes above. The project is Alpha (CLAUDE.md / architecture.md §13.8): no migration is
provided — existing local analytics records, if any, are simply re-accumulated.

## Open Questions

- [ ] Should the health-score weights adapt to inbox size (e.g. de-emphasise hygiene for
  tiny inboxes)?
- [ ] Lifetime totals vs. windowed totals for time-saved and achievements — v1 uses the
  read window (default 30 days); revisit once longer histories exist.

---

**Changelog:**

| Date | Change | Author |
|------|--------|--------|
| 2026-06-28 | Initial draft: health score, time-saved, breakdowns, achievements, daily-counter persistence, and the privacy-safe shareable snapshot (M6). | Claude |
| 2026-07-16 | Resolve the shareable-snapshot **format** (open question, cross-ref #99): the primary share form is a **PNG image** rendered on-device from the aggregate numbers, alongside the existing JSON / plain-text export. | Claude |
