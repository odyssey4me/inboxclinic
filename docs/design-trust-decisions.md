# Design: Trust Decisions

> **Status:** Draft (Alpha)
>
> **Last Updated:** 2026-07-12

## Overview

This document owns the **trust-decision workflow** and the **scoring / prioritisation
interfaces** for Inbox Clinic. In the client-only, local-first model everything here runs
**on-device** in `packages/core` — there is no backend, no server identity, and no network
call for trust logic. The scoring, prioritisation, and action-compilation functions are
**pure** (no I/O) so they are unit-testable in isolation and reusable by a future mobile
client.

It establishes consistent rules for:

- the **trust prompt** surfaced for an undecided sender or batch;
- the **decisions** (Trust / Block / Defer) and the **actions** a Block compiles into;
- the **trust score** model and its display tiers;
- the **priority score** that orders prompts in the workflow;
- the **deferred** collective-signal seam (no v1 network calls).

Persistence (IndexedDB via Dexie) and Gmail/People access are defined elsewhere — see the
Architecture Reference. This doc defines the *interfaces and algorithm constants* those
layers call, not the storage or transport mechanics.

## Architecture Reference

This design implements the following sections of [architecture.md](architecture.md):

> **Keep It DRY:** This doc links to architecture.md for the trust-decision *model*;
> architecture is technology-agnostic, so the formulas and constants below are this
> design's own.

| Section | Title | Relevance |
|---------|-------|-----------|
| 4 | Trust-Decision Model | Subjects, trust/block/defer decisions, prompts & priority, trust-signal categories, enforcement |
| 6 | Core Interfaces | Scoring & prioritisation ports (pure functions); the store interface decisions persist through |
| 9 | Deferred Capabilities & Seams | Aggregate-contribution seam; `contributeToAggregate` setting |

Related design docs: [design-gmail-integration.md](design-gmail-integration.md) (scanning, header/label
sources, native filter compilation) and [design-frontend.md](design-frontend.md) (the four-phase
workflow UI). [design-testing.md](design-testing.md) covers how the pure core functions are tested.

## Design Decisions

### Decision 1: Trust logic is pure and on-device

**Context:** The old design exposed trust logic as a backend API. The new architecture is
client-only with no server (architecture.md §2).

**Decision:** Trust scoring, prioritisation, and action compilation are **pure functions in
`packages/core`** that take plain data in and return plain data out. They perform no I/O —
callers in `apps/web` read from IndexedDB, invoke these functions, and persist results.

**Rationale:** Purity makes the logic deterministic and trivially unit-testable (no DOM, no
mocks for the functions themselves), and lets a future `apps/mobile` reuse the same code
behind a repository port (architecture.md §6, §9).

**Alternatives Considered:**
- Methods on a stateful service class reading the store directly: rejected — couples logic
  to storage, harder to test, not reusable cross-platform.

### Decision 2: Domain decisions override address decisions

**Context:** A user may decide at address or domain scope, and both may exist for one
sender (architecture.md §4).

**Decision:** A **domain** decision overrides any **address** decision for senders in that
domain. An address decision made *after* a domain decision is recorded as an explicit
**exception** (tracked in `domains.exceptionAddresses[]`).

**Rationale:** Matches the user's mental model ("block everything from this domain") while
still allowing fine-grained exceptions. Resolution is a pure precedence rule (see
`resolveEffectiveDecision`), so it stays consistent across the app.

**Alternatives Considered:**
- Address precedence: rejected — contradicts the intent of choosing domain scope.
- Prompt-to-resolve conflicts: rejected — adds friction.

### Decision 3: Defer decays priority; the TTL bounds it

**Context:** Users can defer ("not sure"). Deferred prompts must resurface without clogging
the queue (architecture.md §4).

**Decision:** A deferred prompt's priority decays **×0.9 per week** and is still subject to
the **30-day TTL**. No hard defer limit — decay plus TTL retire stale prompts naturally.

**Rationale:** Respects uncertainty without abandoning or dominating the queue; after ~10
weeks priority is negligible and the TTL has expired the prompt regardless.

### Decision 4: Network signals deferred — v1 re-normalises the weighting

**Context:** The full trust model blends User, Network, and Compliance signals, but the
cross-user aggregate is deferred (architecture.md §4, §9).

**Decision:** v1 omits the Network group and scores with **User × 0.77 + Compliance ×
0.23** (the full 0.50/0.15 split re-normalised to 1.0). The schema keeps null network
fields and a `contributeToAggregate` setting (default on); **no network calls are made**.

**Rationale:** Introducing the aggregate later shifts weighting back to 0.50/0.35/0.15 with
**no data-model change** — the seam is in place from day one.

### Decision 5: Bounded trust history (max 50) with decision context

**Context:** Each sender tracks decision changes for audit and undo (architecture.md §4).

**Decision:** Keep at most **50** `trustHistory` entries per sender, trimming oldest first.
Capture **decision context** (what was true at decision time — read rate, count, frequency,
trust score, category, decided-via) on each decision.

**Rationale:** 50 is ample for audit/undo and bounds growth; context enables meaningful
"why did I decide this" review and informs the Alignment signal.

### Decision 6: Decisions are revisable

**Context:** A trust/block/defer decision is not a one-off — a person changes their mind (a
blocked newsletter becomes wanted; a trusted sender goes rogue).

**Decision:** Any recorded decision can be **changed at any time** from a **Decisions** view.
Re-deciding is the same `applyDecision(...)` over the store, followed by enforcement
reconciliation: the durable blocked set is recomputed, so reversing a Block **removes** its
native filter and reversing a Trust re-adds any warranted filter (enforcement is idempotent
and reconciled from current state, not per-event — see design-gmail-integration.md Decision 5).
A reversal may also **rescue affected mail from Trash** (Decision 7 and
design-gmail-integration.md Decision 8).

**Rationale:** Trust is a living judgement; because filters already reconcile from the durable
set on every sync, reversal needs no special path beyond re-recording the decision and offering
to restore mail.

### Decision 7: Impact preview & explicit confirmation before applying

**Context:** A Block can archive or **delete** existing mail and auto-handle future mail.
Destructive actions must never surprise the user.

**Decision:** Before a decision is enforced, the UI shows a **count-only impact preview** and
requires **explicit confirmation**:
- **Now** — existing mail affected: *archives N*, **deletes M** (to Trash — recoverable for
  ~30 days), filters ±K, and *restores R from Trash* on a reversal.
- **Going forward** — extrapolated volume the rule will auto-handle, from the sender's
  frequency / recency (Algorithm Constants).

Deletion is called out prominently and **nothing mutates Gmail until confirmed**. The counts
come from a no-mutation **simulation** (design-gmail-integration.md Decision 8). Block's default
staged actions are unchanged (`compileActionsForBlock`): the future filter **trashes new mail by
default**, while **deleting existing mail is opt-in**.

**Rationale:** Reversibility (Trash, not permanent delete) + preview + confirm makes
aggressive-but-safe blocking trustworthy.

### Decision 8: Learn prior decisions from Gmail (confirm-first, read-weighted)

**Context:** Most inboxes already encode the user's judgement — existing filters, spam-marks,
binned mail. Showing everything as "pending" ignores decisions already made.

**Decision:** On first run, **derive suggested Block decisions** from the account's existing
state and present them as a **confirm-first import** ("Found N prior decisions — import as
Blocked?"). Sources and weighting:
- **Existing native filters** that trash/archive/spam a sender/domain → strong Block signal.
- **Spam-labelled** mail → strong Block signal.
- **Trashed** mail → a Block signal **only when it was unread when binned** (deleted without
  opening). **Read-then-deleted is normal triage and is _not_ a signal** — weighted by the
  sender's read-rate (the unread-share threshold is a tunable constant).

Suggestions are **never auto-applied and never destructive** (the mail is already handled by
Gmail); the user reviews and imports. Imported blocks then behave like any decision (revisable,
Decision 6). The read scope for learning is in design-gmail-integration.md Decision 7.

**Rationale:** Confirm-first respects agency (an old filter may be stale); read-weighting avoids
mislabelling senders the user actually reads and then clears.

## Interfaces

All interfaces live in `packages/core`. Types below are interface-level (illustrative
field sets); the canonical store shapes are in [design-local-store-schema.md](design-local-store-schema.md).

### Shared types

```ts
type TrustStatus = 'trusted' | 'blocked' | 'pending';
type DecisionScope = 'address' | 'domain';
type DecidedVia = 'workflow' | 'dashboard' | 'settings';
type SenderCategory =
  | 'newsletter' | 'promotion' | 'social' | 'forum'
  | 'transactional' | 'personal' | 'unknown';
type Frequency = 'daily' | 'weekly' | 'monthly' | 'rare';

/** Read-only snapshot a scorer needs. No store handles, no I/O. */
interface SenderSnapshot {
  email: string;
  domain: string;
  category: SenderCategory;
  totalEmails: number;
  emails30d: number;
  lastEmailAt: number;            // epoch ms
  readRate: number | null;        // 0..1
  frequency: Frequency;
  hasListUnsubscribe: boolean;
  inContacts: boolean;            // deferred: always false until the Tier-3 lookup ships
  /** Recency-bucketed user-signal occurrences, e.g. { replied: {...} }. */
  userSignals: UserSignalCounts;
  auth: { spf: boolean; dkim: boolean; dmarc: boolean; spoofed: boolean };
}

interface UserSignalCounts {
  // per signal: occurrence counts bucketed by recency window
  [signal: string]: { d30: number; d90: number; d180: number; older: number };
}
```

### `computeTrustScore(sender)`

```ts
interface TrustSignal { label: string; value: number; weight: number; }

interface TrustScoreResult {
  score: number;                  // clamped to -10..+10
  tier: 'highly-trusted' | 'generally-trusted' | 'mixed'
      | 'questionable' | 'widely-distrusted';
  colour: 'green' | 'light-green' | 'grey' | 'orange' | 'red';
  components: { user: number; compliance: number; network: number | null };
  signals: TrustSignal[];         // supporting evidence for the UI
}

/** Pure. v1 weighting: User×0.77 + Compliance×0.23 (network omitted). */
function computeTrustScore(sender: SenderSnapshot): TrustScoreResult;
```

| Field | Type | Description |
|-------|------|-------------|
| `score` | number | Final clamped score, −10…+10 |
| `tier` / `colour` | enum | Display tier (see Trust Tiers) |
| `components.network` | number \| null | **null in v1** until the aggregate ships |
| `signals` | TrustSignal[] | The weighted contributions, for transparency |

### `prioritisePrompts(...)`

```ts
interface PriorityComponents {
  impact: number; confidence: number; batch: number; alignment: number;
}
interface PrioritisedPrompt {
  senderId: string;
  priorityScore: number;          // 0..100
  components: PriorityComponents;
  batchGroupId: string | null;    // e.g. "domain:company.com"
  batchSize: number;
}
interface UserDecisionHistory {
  blockRateForCategory(c: SenderCategory): number;   // 0..1
  blockRateForTld(tld: string): number;              // 0..1
  blockRateForReadBand(readRate: number | null): number;
  hasDecisions: boolean;
}

/** Pure. Sorts undecided senders by priority, attaching batch grouping. */
function prioritisePrompts(
  candidates: SenderSnapshot[],
  history: UserDecisionHistory,
  now: number,
): PrioritisedPrompt[];
```

### `compileActionsForBlock(...)`

```ts
type BlockAction = 'unsubscribe' | 'create_filter' | 'archive' | 'delete';

interface BlockActionPlan {
  scope: DecisionScope;
  actions: BlockAction[];         // smart defaults by category, user-overridable
  /** Why each default was chosen — surfaced in the Review phase. */
  rationale: Partial<Record<BlockAction, string>>;
}

/** Pure. Produces the suggested action set; does NOT execute it. */
function compileActionsForBlock(
  sender: SenderSnapshot,
  scope: DecisionScope,
): BlockActionPlan;
```

Execution of the plan (sending unsubscribe, writing the native Gmail filter, archiving /
deleting) is performed by the Gmail adapter — see
[design-gmail-integration.md](design-gmail-integration.md). `unsubscribe` is only offered when
`hasListUnsubscribe` is true; filter compilation and the 450/500 soft cap are defined in
[design-gmail-integration.md](design-gmail-integration.md).

### `resolveEffectiveDecision(...)`

```ts
/** Pure precedence rule: domain overrides address unless an exception exists. */
function resolveEffectiveDecision(input: {
  addressStatus: TrustStatus | null;
  addressIsException: boolean;
  domainStatus: TrustStatus | null;
  domainScope: DecisionScope | null;
}): { status: TrustStatus; source: 'address' | 'domain' | 'none' };
```

## Algorithm Constants

These constants are owned by this design — architecture.md §4 defines the trust-decision
*model*, not the values. They are the implementation contract.

### Trust scoring

| Group | v1 weight | Full weight |
|-------|-----------|-------------|
| User | 0.77 | 0.50 |
| Compliance | 0.23 | 0.15 |
| Network (deferred) | — | 0.35 |

**User signals** (−10…+10 before weighting): replied **+3**, in contacts **+2**
_(deferred — see below)_, frequently starred **+2**, consistently opened >80% **+1**,
never opened **−1**, frequently deleted-unread **−1** _(≥2 messages binned while unread;
stacks with never-opened)_, manually marked spam **−2**, repeatedly marked spam **−3**.

> **Deferred signal:** `inContacts` is **not live in v1** — see
> [ROADMAP.md](ROADMAP.md#deferred-post-v1). It has a schema field and scoring branch in
> place as a seam (`SenderSnapshot.inContacts`, `computeTrustScore`), but the Tier-3 People
> API lookup that would populate it is not built, so the field is always `false` and the +2
> branch never fires (`packages/core/src/ports/GmailClient.ts` — Tier 3 scopes).
>
> **"Frequently deleted-unread"** is **live (#98):** `SenderSnapshot.deletedUnreadCount`
> fires the −1 at **≥2** messages binned while unread, stacking with never-opened. It is
> populated from the prior-decisions learn pass's Trash scan (not the inbox scan — the score
> input the inbox can't see), so it reflects the current Trash window and refreshes when that
> pass runs. Exposure is **score-only** (it moves the visible score/tier; no bespoke UI text).

**Recency weights:** ≤30d **×1.0**, 30–90d **×0.7**, 90–180d **×0.4**, >180d **×0.2**.

**Compliance signals:** SPF+DKIM+DMARC all pass **+2** (two pass **+1**; spoofed **−3**);
`List-Unsubscribe` present **+1** (absent **−1**).

### Trust tiers (display)

| Score | Tier | Colour |
|-------|------|--------|
| +7…+10 | Highly Trusted | Green |
| +3…+6 | Generally Trusted | Light green |
| −2…+2 | Mixed / Unknown | Grey |
| −6…−3 | Questionable | Orange |
| −10…−7 | Widely Distrusted | Red |

### Prompt priority — `Impact×0.4 + Confidence×0.3 + Batch×0.2 + Alignment×0.1`

| Component | Sub-formula (caps) |
|-----------|--------------------|
| **Impact** | volume `min(total/100,1)×0.5` + frequency (daily 0.3 / weekly 0.2 / monthly 0.1 / rare 0.05) + recency (≤30d 0.2 / 30–90d 0.1 / else 0) |
| **Confidence** | `|read−0.5|×2 × 0.4` + listUnsub 0.2 + historyLen 0.2 + categoryConsistency 0.2 |
| **Batch** | domainGrouping (5+ → 0.6 / 3+ → 0.4 / 2+ → 0.2) + combinedVolume `min(batchTotal/200,1)×0.4` |
| **Alignment** | categoryBlockRate ×0.5 + tldBlockRate ×0.3 + readBandBlockRate ×0.2 (0.5 neutral when no history) |

Final priority is the weighted sum scaled to **0–100**.

### Lifecycle constants

| Constant | Value |
|----------|-------|
| Prompt TTL | 30 days |
| Defer decay | ×0.9 per week (bounded by TTL) |
| Max trust history entries | 50 |
| Filter OR-combine limit / soft cap | ≤10 domains per filter / 450 of 500 |

## Collective / Network Signals (Deferred)

Per architecture.md §9, collective trust intelligence is **deferred** but its seam ships in
v1:

- `packages/core` exposes a **contribution interface** through which a decision *could* feed
  a future anonymous, one-way aggregate.
- Each profile carries `privacy.contributeToAggregate` (**default on**).
- v1 **stores decisions locally only and makes NO network calls.** `TrustScoreResult.
  components.network` and `decisionContext.collectiveScore` remain **null**.
- When the aggregate ships, scoring shifts to the full 0.50/0.35/0.15 weighting and the
  network component populates — no schema or interface change. Future aggregate privacy
  rules (activation thresholds, one-way contributions, opted-out users still consuming the
  signal) are defined in architecture.md §9.

## Error Handling

These are pure functions, so failures are **input-validation** concerns, not runtime/network
errors. Adapters that execute action plans handle Gmail/People failures (see
gmail-integration.md).

| Condition | Behaviour |
|-----------|-----------|
| `readRate` null | Confidence read-rate term contributes 0; score still computed |
| No `UserDecisionHistory` | Alignment returns neutral 0.5 |
| Score out of range | Clamped to −10…+10 before tiering |
| Empty candidate list | `prioritisePrompts` returns `[]` |
| Unsubscribe requested without `List-Unsubscribe` | Action omitted from the compiled plan |

## Examples

### Compute a trust score (v1 weighting)

```ts
const result = computeTrustScore(sender);
// result.components.network === null  (deferred)
// result.tier drives the badge colour; result.signals explains "why" in the UI
```

### Order the workflow queue

```ts
const queue = prioritisePrompts(undecidedSenders, history, Date.now());
// queue[0] is the highest-priority prompt shown in the Discovery phase;
// queue[0].batchGroupId offers a "decide for the whole domain" batch.
```

### Compile a Block plan (defaults overridable in Review)

```ts
const plan = compileActionsForBlock(sender, 'address');
// e.g. newsletter → ['unsubscribe', 'create_filter', 'archive']
// The Gmail adapter executes plan.actions; this function never performs I/O.
```

## Migration Notes

This supersedes the previous backend-API trust-decisions design. The removed surface:

- All `POST /v1/senders/...` and `/v1/prompts` HTTP endpoints — replaced by pure
  `packages/core` functions called in-browser.
- Firestore/Cloud Run/worker batch-job mechanics — replaced by IndexedDB (architecture.md
  §5) and in-app invocation.

The **algorithms, scope/override rules, defer decay, trust-history bound, and constants are
unchanged** — only the execution location (server → device) and the interface shape
(REST → TS functions) differ. No user-facing migration: Alpha permits breaking changes.

## Open Questions

- [ ] Should the Alignment "read band" boundaries be fixed (e.g. quartiles) or learned per
  user? Architecture.md leaves the band definition to this layer.
- [ ] Smart-default action sets per category — confirm the exact default `BlockAction[]` per
  `SenderCategory` before implementation.

---

**Changelog:**

| Date | Change | Author |
|------|--------|--------|
| 2026-07-16 | **Implement the "frequently deleted-unread" (−1) signal (#98).** Adds `deletedUnreadCount` to the store `Sender` + `SenderSnapshot`; `computeTrustScore` fires −1 at **≥2** messages binned while unread, **stacking** with never-opened. Populated from the prior-decisions learn pass's Trash scan (no extra Gmail calls; carried across rescans); exposure is **score-only**. Moved off the ROADMAP Deferred list. | Claude |
| 2026-07-12 | Clarify that `inContacts` (+2) and "frequently deleted-unread" (−1) are **deferred, not implemented** in v1 — matches the code and cross-links to ROADMAP.md's Deferred table. Documentation-only; no scoring or scope change. | Claude |
| 2026-07-05 | Add the **Decisions milestone** model: Decision 6 **revisable decisions** (change later → reconcile filters + rescue from Trash); Decision 7 **impact preview + explicit confirm** before applying (deletes are loud; block trashes future by default, delete-existing opt-in); Decision 8 **learn prior decisions** from filters + **read-weighted** Spam/Trash as confirm-first suggestions. | Claude |
| 2026-06-28 | Rewritten for the client-only, local-first, all-TypeScript PWA model: pure on-device `packages/core` interfaces, network signals deferred (v1 User×0.77 + Compliance×0.23), no backend. Supersedes the backend-API design. | Claude |
| 2025-12-30 | Approved (previous backend-API design) | Claude |
| 2025-12-30 | Initial draft | Claude |
</content>
</invoke>
