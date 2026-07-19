# Design: Frontend

> **Status:** Approved (Alpha)
>
> **Last Updated:** 2026-07-16

## Overview

This document defines the frontend for Inbox Clinic: a **client-only, local-first,
all-TypeScript browser PWA with no backend**. It owns **UI component patterns, state
management, and the trust-decision interaction**. The app is a static **Vite + React +
Tailwind** SPA; all product logic lives in a framework-agnostic `packages/core`, and all
user data lives **on-device in IndexedDB (Dexie)**.

This replaces the previous Next.js design (SSR, server components, TanStack-Query-against-
our-API, admin/status routes). Those concepts are gone: there is **no app server, no SSR,
no app-backend fetching**. The only network calls are direct browser → Google API calls.

**Scope:** rendering strategy, component architecture, state management, the trust-decision
workflow UX, accessibility/responsive conventions, and the privacy export/delete UX.

**Out of scope (linked, not duplicated):**
- Gmail OAuth (PKCE), scanning, filter compilation — see [design-gmail-integration.md](design-gmail-integration.md).
- Trust scoring, prioritisation, decision persistence — see [design-trust-decisions.md](design-trust-decisions.md) and architecture.md §4.
- Test conventions — see [design-testing.md](design-testing.md).

## Architecture Reference

This design implements the following sections of [architecture.md](architecture.md).
It does not restate them; it defines how the UI realises them.

| Section | Title | Relevance |
|---------|-------|-----------|
| 3 | System Model | Client-only topology; `apps/web` (presentation) over `packages/core` (logic); service worker |
| 6 | Core Interfaces | The UI depends on the store and provider-client ports; it renders their output and holds no business rules |
| 7 | Access, Openness & Funding | Static, reproducible build; opt-in **local** shareable snapshot (no server, no referral tracking) |
| 8 | User Settings & Opt-in Features | User-controlled opt-in toggles stored on-device |

## User Journeys

The interface is designed around four primary journeys. The **same on-device decision
model** underlies them all; the **decisions surface** (a table on desktop, a card list on
mobile — Decision 8) and the **guided workflow** (Decision 6) are two entry paths to the
same decisions, and the **home page leads with the decisions surface** on both layouts.

1. **Blast through pending decisions fast.** The guided **Triage → Review → Execution**
   workflow: evidence + Trust/Block/Defer inline, one tap (or `T`/`B`/`D`/`S`) per sender,
   auto-advancing. It is the **primary** triage path on **mobile** (touch, sequential); on
   **desktop** it is an optional fast-path launched from the decisions surface via
   **"Triage pending →"**.
2. **Find a specific sender or domain and act.** The decisions surface: **search** + **sort**
   (message volume, unread/ignored rate, recency, trust score, decision status, name/domain)
   locate the subject; **inline Trust/Block/Defer** or the detail panel act on it.
3. **Review and change a past decision.** The same surface, filtered to **Decided**; the
   row opens the detail panel to change the decision (re-previews impact, reconciles filters).
4. **Block a whole domain and manage address exceptions.** **Group by domain** in the
   surface: a domain acts on all its members (`scope: "domain"`), with per-address exceptions
   managed in the detail panel.

Scoring, prioritisation, and decision semantics are owned by
[design-trust-decisions.md](design-trust-decisions.md) / architecture.md §4 — the UI renders
their output.

## Design Decisions

### Decision 1: Vite + React + Tailwind, static SPA (no SSR)

**Context:** architecture.md §3 describes a client-only app with no application servers;
the static-SPA, Vite + React + Tailwind, and PWA-from-day-one choices are this design's
(architecture is technology-agnostic).

**Decision:** Build `apps/web` as a Vite React SPA, styled with Tailwind, output as static
assets. No SSR, no server components, no Next.js.

**Rationale:** A static SPA matches the client-only topology, deploys to GitHub/Cloudflare
Pages with zero servers, and keeps the build trivially reproducible by forkers (§7). Vite
gives fast dev + a small static bundle.

**Alternatives considered:**
- *Next.js (previous design):* requires/encourages a server runtime; SSR and server
  components are meaningless with no backend and no per-request data. Rejected by §2 (client-only).
- *Remix / TanStack Start:* server-oriented data loading we have no use for.

### Decision 2: Logic in `packages/core`, presentation in `apps/web`

**Context:** §6 (provider/UI-agnostic core) and §9 (additional clients) require product
logic to be framework-agnostic and unit-testable without a DOM, and reusable by a future
mobile client.

**Decision:** All scoring, prioritisation, filter compilation, Gmail access, and the
**store repository** live in `packages/core` as plain TypeScript (ports-and-adapters).
`apps/web` only renders state and dispatches intents into core. React components contain no
business rules.

**Rationale:** Keeps the coverage-gated logic testable in isolation (§6) and lets a
Capacitor/React-Native shell reuse the same core (§9). The repository interface is the
single seam between UI and IndexedDB.

### Decision 3: Local-first state — the Dexie store is the source of truth

**Context:** §5 keeps **all** user data on the device. There is no server state of our own.

**Decision:** UI state has three tiers:

| Tier | Holds | Mechanism |
|------|-------|-----------|
| **Persistent (app state)** | senders, domains, prompts, decisions, analytics, settings | Dexie via the core **repository interface**; React subscribes with `useLiveQuery` (Dexie React hooks) |
| **Ephemeral (UI state)** | modal open, selected tab, form drafts, wizard step | React `useState` / context |
| **Server state (Google only)** | in-flight Gmail/People API calls | Core-owned **`fetchWithRetry`** (retry/backoff, in-flight handling) — **no** TanStack Query |

Reads and writes go through the repository (`core/store`), never directly to Dexie from a
component. `useLiveQuery` makes the UI reactive: when core writes a decision, every view
re-renders from IndexedDB automatically.

**Rationale:** A single local source of truth removes cache-coherency problems and works
fully offline. Google API calls use a thin core-owned **`fetchWithRetry`** (retry/backoff,
in-flight handling) — **not** TanStack Query and never app-data caching, because there is no
app backend to fetch from and IndexedDB + `useLiveQuery` already provide reactive app state.

**Alternatives considered:** Redux/Zustand global store — redundant when IndexedDB +
`useLiveQuery` already provide reactive shared state.

### Decision 4: PWA with offline cache + periodic sync from day one

**Context:** §1 (local-first, mobile-ready) motivates an installable PWA; §3 shows the
client reconciling periodically with the provider; [design-gmail-integration.md](design-gmail-integration.md)
defines polling-based incremental sync.

**Decision:** Ship a service worker on first release that (a) precaches the app shell and
static assets for offline launch, and (b) registers **Periodic Background Sync** (where the
platform permits) to let core run an incremental Gmail sync while the app is closed,
falling back to on-open sync otherwise.

**Rationale:** Offline launch and "add to home screen" are baseline expectations for a
local-first tool; periodic sync surfaces new prompts without a push pipeline (none exists in
the client-only model). Capability is feature-detected — degrade gracefully where Periodic
Sync is unavailable (e.g. iOS Safari).

### Decision 5: Component vocabulary — ui primitives + composed components

**Context:** Retain the prior, well-understood component vocabulary, but as plain
React/Vite (no `"use client"`, no Next imports).

**Decision:** Two layers under `apps/web/src/components/`:

| Layer | Examples |
|-------|----------|
| `ui/` (primitives) | `button`, `card`, `dialog`, `badge`, `progress`, `tabs`, `tooltip` |
| `composed/` (app components) | `prompt-card`, `decision-row`, `trust-actions`, `domain-card`, `undo-dialog`, `score-indicator`, `signal-list`, `batch-offer` |

Primitives stay accessible (keyboard, focus, ARIA) and unstyled-by-default; composed
components express product concepts. Screens compose these; they hold no business logic.

### Decision 6: Three-phase trust-decision workflow as a guided wizard

**Context:** §4 defines prompts, trust/block/defer decisions, and prompt expiry. This
design realises them as a stepper: **Triage → Review → Execution**.

**Decision:** Implement the workflow as a stepper. **Triage** shows each sender's evidence
(score, signals) *with the Trust/Block/Defer actions inline* — one screen, one decision,
auto-advancing — so the common case is a **single tap** (or a `T`/`B`/`D`/`S` keypress).
Block uses smart defaults in one tap, with a **"Customize"** expander for the action
checkboxes. **Review** shows the staged changes with the **impact preview** (Decision 7 of
design-trust-decisions.md) before the user confirms. No Gmail mutation happens until
**Execution**; everything before it edits a **local pending-decision list**.

> Discovery and Decision were originally separate (an extra "Make a decision" click that
> re-showed the same card); they were merged into **Triage** to cut per-sender clicks to one.

### Decision 7: "Vitals" design system — semantic tokens, light + dark by system

**Context:** The app is a calm, trustworthy inbox *clinic*. The visual language should lean
into that metaphor with restraint — familiar terms ("Inbox health", "Trust / Block /
Defer"), a clinical-but-warm palette, and no medical jargon — while supporting light and
dark automatically.

**Decision:** A single set of **semantic design tokens** defined as CSS custom properties in
`apps/web/src/index.css`, exposed to Tailwind v4 via `@theme inline` so utilities
(`bg-surface`, `text-ink`, `text-muted`, `border-line`, `text-accent`, `text-trust`,
`text-block`, `text-defer`, …) resolve through the tokens. Components **never** use raw
Tailwind palette colours (`slate-*`, `red-*`) — only tokens — so both themes stay
consistent from one source.

| Token group | Purpose |
|-------------|---------|
| `bg`, `surface`, `surface-2` | Page ground and raised surfaces (cards, chips) |
| `ink`, `muted` | Primary and secondary text |
| `line` | Hairline borders / dividers |
| `accent`, `accent-soft`, `accent-ink`, `on-solid` | Teal brand accent (health/score/links) and text-on-fill |
| `trust`, `block`, `defer` | Semantic decision colours, always paired with text/icon |

- **Palette:** cool near-white ground with a slight teal bias; a calm teal (`#0d9488` light
  / `#2dd4bf` dark) as the single bold accent — reserved for inbox-health, score, and
  links, not spent on every button. Neutrals are teal-biased, not grey.
- **Theming:** `:root` holds the light values; a single `@media (prefers-color-scheme:
  dark)` block redefines the tokens. **System-detected** — no manual theme toggle. Semantic
  chips use an alpha tint of their token (`bg-trust/15 text-trust`) so they read correctly
  on either ground.
- Emphasis buttons use `bg-ink text-bg` (always high-contrast in both themes); the
  destructive **Block** action is the only coloured fill (`bg-block`).

### Decision 8: The home page is one searchable, sortable decisions surface (+ a detail panel)

**Context:** The dashboard originally juxtaposed an inbox-health hero, clickable **count
tiles**, a separate **Pending decisions** panel, and a **senders/domains** list — surfacing
the same senders and domains as links across several competing widgets (and on desktop the
pending aside **overlapped** the table). The real work — deciding senders quickly and
revisiting past decisions — is served better by one powerful list than by juxtaposed
dashboard widgets.

**Decision:** The home page is a **single decisions surface** over senders (with a **Group by
domain** toggle for deciding a domain and its members together), rendered as a **table on
desktop** and a **card list on mobile** (the existing two-layout split — Application shell &
navigation), with a shared detail panel:

- **Searchable and sortable** — sort by message volume, unread/ignored rate, recency, trust
  score, decision status, and name/domain (sortable column headers on desktop; a sort
  control / sheet on mobile). Search filters the list. **Search + sort are the primary
  "decide quickly" tools** the desktop canvas rewards.
- **Filter tabs `Pending · Decided · All`**, with the **counts in the tab labels** (e.g.
  "Pending 12") — the standalone clickable **count tiles are removed**.
- A **Group by domain** toggle so a domain and its member senders are decided together (a
  domain decision applies with `scope: "domain"`, `subjectId = keyFor(domain)`; per-address
  exceptions in the detail panel). The sender surface resolves each sender's **effective**
  status (`resolveEffectiveDecision`) so a domain decision shows on its members too.
- A **status column** and **inline Trust / Block / Defer** per row for fast triage (a
  primary action + overflow on a mobile card, to keep ≥44px touch targets). Safety is
  unchanged (design-trust-decisions.md Decision 7): **Trust/Defer apply immediately**;
  **Block** simulates and shows the impact (archive/delete counts, weekly volume), then
  requires an explicit **Confirm block**.
- **Row click opens the detail panel** — a **right-side panel on desktop**, a **bottom sheet
  on mobile** (the shared `ui/Drawer` shell: labelled `role="dialog"`/`aria-modal`, Escape /
  backdrop dismissal). `SenderDetail` reuses `PromptCard` (evidence/score) + `TrustActions`
  (address/domain scope, per-address exceptions) + the **impact preview** + decision history;
  `DomainDetail` (the group-by-domain view) shows the aggregate (sender count, volume,
  status), an averaged member score, and drillable members. **Changing a decision happens
  here too.** Both are
  presentation-only (Decision 2) — they call `applyDecision` + `enforce` and notify the home
  page via `onChanged`.
  - **Prior-block signals in the panel (#96):** when the open sender has same-domain **flagged
    siblings** (already spam/binned/filtered), `SenderDetail` renders an **inline offer** beneath
    the actions — **Block all** / **Keep all** (an allow decision) / **Not now** (Defer). The
    guided workflow keeps its existing domain `BatchOffer` (decide the whole domain). The learn
    pass runs on the home surface's mount to populate the prior-block scoring signals, so flagged
    senders sort up — this **replaces the standalone "Import all as Blocked" card**. Semantics:
    design-trust-decisions.md Decision 8.
- The **inbox-health score is not on the home page** — its meaning and next action aren't
  clear here; it lives on **Analytics**. The home page leads with the decisions surface.
- The **guided workflow (Decision 6)** remains an optional **"Triage pending →"** fast-path
  launched from the surface — the *primary* triage path on **mobile**, an escape hatch on
  **desktop** where the table + inline actions is primary.

**Rationale:** One list — searchable, sortable, filterable, group-able, with inline actions
and a detail panel — serves all four home-page journeys without duplicating senders across
competing widgets, makes **search + sort** the fast path the desktop canvas rewards, and
fixes the overlap by making the detail a proper side-panel / bottom sheet rather than a
fixed aside.

## Interfaces

### Repository interface (UI ⇄ store)

`apps/web` depends only on this port from `packages/core`; the Dexie implementation is an
adapter behind it.

```typescript
// packages/core/store/repository.ts
export interface Repository {
  // Reactive reads return Dexie queries the UI subscribes to via useLiveQuery
  dashboardSummary(): Promise<DashboardSummary>;   // health score, blocked count, pending count, 30d summary, top domains
  topPrompt(): Promise<Prompt | null>;             // highest-priority undecided prompt (Discovery)
  promptBatch(groupId: string): Promise<Prompt[]>; // similar senders for a batch offer
  listDomains(filter: DomainFilter): Promise<Domain[]>;
  listDecisions(filter: DecisionFilter): Promise<Sender[]>;
  analytics(range: 'daily' | 'monthly'): Promise<AnalyticsSeries>;

  // Writes (pending list lives in memory until Execution commits it)
  recordDecision(d: DecisionInput): Promise<void>;      // trust | block | defer
  revokeDecision(senderId: string): Promise<void>;
  setDomainException(domain: string, address: string, status: TrustStatus): Promise<void>;
  setPrivacyContribution(enabled: boolean): Promise<void>;

  // Privacy (§5)
  exportAll(): Promise<Blob>;     // dump IndexedDB to a downloadable file
  deleteAllLocal(): Promise<void>; // clear every object store
}
```

### Trust-decision workflow (the interaction this doc owns)

| Phase | UI | Key elements |
|-------|----|--------------|
| **Triage** | `prompt-card` + `trust-actions` | Evidence (`score-indicator` e.g. ●●●●○, 3–4 `signal-list` statements, read rate / count / frequency / category) shown **with the actions inline** — one screen, one decision, auto-advancing: **Trust** (one tap), **Block** (one tap with smart defaults; a **Customize** expander reveals the action checkboxes — unsubscribe if `List-Unsubscribe` ✓, create filter ✓, archive ✓, delete ○), **Defer**. Keyboard: `T`/`B`/`D`/`S`. An optional **`batch-offer`** applies the decision to a whole domain. |
| **Review** | `decision-row` list + **impact preview** | Summary ("47 senders: 12 trusted, 35 blocked") with each row editable (flip trust ↔ block, remove). The **impact preview** dry-runs the staged changes read-only (a Gmail search per rule) — filters ±, existing mail archived / **deleted**, mail rescued, plus extrapolated future volume — before the user confirms **Apply**. |
| **Execution** | `progress` + summary | Apply via core (Gmail mutations + filter compilation) with a live progress bar. Completion summary lists successes/failures; decisions are **revisable later** in the Decisions view. |

Scoring, signal selection, smart-default presets, priority, defer-decay and the 30-day
expiry are **owned by [design-trust-decisions.md](design-trust-decisions.md) / architecture.md §4** — the UI renders their
output and must not re-derive them.

### Application shell & navigation

Once signed in, **every screen renders inside a persistent application shell** — the
`Inbox Clinic` brand (a link home), the signed-in account, primary navigation
(**Dashboard · Analytics · Settings**), a single **Refresh** action (incremental sync,
with a last-synced indicator + result summary; the heavier full **Rescan** lives in
Settings), and the offline
indicator stay fixed while only the content area swaps. This gives a stable anchor — who
you are, where you are, how to get home — across all views, instead of each screen
re-declaring its own header. Screens are therefore **content-only** (no per-screen brand
or "Back" chrome); a screen may render its own `<h2>` title. The **signed-out landing**
page is the one exception (its own centred layout).

Navigation uses **history routing** via **`react-router-dom`** (a standard, replaceable router —
architecture.md §1 *Use the ecosystem*): clean, bookmarkable URLs (`/`, `/triage`, `/analytics`,
`/settings`) with a **Cloudflare Pages SPA fallback** (`apps/web/public/_redirects`), and the
shell highlights the active route. `App` derives the view from the path, preserves `?demo=1`
across navigation, and falls back to the home surface for an unknown path. The **Trust-decision
workflow** is launched from the home surface and renders inside the shell as a focused sub-flow
(`/triage`, with its own progress header + exit), so the anchor is never lost mid-flow. The home
surface's active **tab** (`?tab=decided|all`) and an open **detail** (`?sender=<id>` / `?domain=<id>`)
are also URL-controlled (#120). Tab changes **push**, so they're bookmarkable and back/forward moves
between tabs; an open detail is linkable but transient, so it **replaces** the history entry rather
than flooding it with drawer toggles (only one detail opens at a time — `sender` wins if both are
set). Every setter merges params, so `?demo=1` survives.

**Two distinct layouts, user-switchable.** The shell renders one of two structurally
different layouts, chosen by `useLayout` (`layout/context.ts` + `LayoutProvider`):

| | Mobile shell | Desktop shell |
|-|--------------|---------------|
| Structure | Top bar; single content column | Left **sidebar** (brand, vertical nav, account); wide content |
| Nav | Horizontal pills | Vertical list in the sidebar |
| Account menu (**holds the layout switch**) | Header disclosure menu | Sidebar-foot disclosure menu |
| Content width | `max-w-3xl`, stacked | up to `max-w-6xl`; the home **decisions table** gains its **detail side-panel**, and Analytics goes multi-column |

The layout is not merely CSS breakpoints: a **`LayoutSwitch`** (Auto / Desktop / Mobile)
lets the user pin either layout, remembered on-device (`localStorage`). It lives inside the
**account menu** (an occasional preference, not persistent chrome). `auto` follows the
`(min-width: 1024px)` breakpoint. Because a page can be forced to a layout its viewport
wouldn't otherwise choose, screens branch on the JS `layout` value (not `lg:` utilities).
Pinning **Desktop** on a small screen also widens the `viewport` meta to `width=1024` so the
desktop layout has room (mobile browsers zoom to fit; desktop browsers ignore it).

### Demo mode

The landing page offers **"Explore the demo"** (also reachable at `?demo=1`) — a no-Google
path so anyone can try the full product without an allowlisted account, and the substrate
for the Tier-3 Playwright suite (see [design-testing.md](design-testing.md) Decision 7).

- **Ephemeral & in-memory.** Demo builds the client trio from `@inboxclinic/core/demo`: a
  demo `GmailClient` over a curated fixture inbox, an **in-memory store** seeded with
  ~15 realistic senders/domains/prompts + history (so Dashboard, the workflow, and Analytics
  are populated immediately), and an **in-memory backup**. It never touches Google, the
  network, or the user's real IndexedDB; real auth is bypassed with a demo identity.
- **Signposted.** A persistent **Demo banner** ("sample data; nothing is sent to Google")
  with an **Exit demo** action sits in the shell so demo state is never mistaken for real.
- **Selection.** `main.tsx` reads `?demo` and constructs the demo trio instead of the
  Browser adapters; the non-demo path is unchanged.

### Screens

| Screen | Composed of | Notes |
|--------|-------------|-------|
| **Dashboard (home)** | decisions table / card list, filter tabs, search + sort, `SenderDetail` detail panel | The single **decisions surface** (Decision 8): search/sort senders, group by domain, `Pending · Decided · All` tabs, inline Trust/Block/Defer, row → detail panel to view/change. **Subsumes the standalone Decisions view and Domain explorer** (their browsing lives here now); Settings keeps exceptions/privacy/export. Inbox-health moved to Analytics; the workflow launches from **"Triage pending →"**. |
| **Trust-decision workflow** | the three phases above | Optional **"Triage pending →"** fast-path launched from the home surface (the primary triage path on mobile). |
| **Domain explorer** | `domain-card` grid, drill-in sender list, unsubscribe tracker | **Folded into the decisions surface** via the group-by-domain view (Decision 8). Browse by volume/status; start a workflow on a selection. |
| **Past decisions / settings** | `decision-row` list, filters, exception editor, toggles | Review/revoke; domain exceptions; **privacy toggle** (`contributeToAggregate`); **export/delete**; undo. |
| **Analytics** | trend charts, category breakdown, achievements, share | Daily/monthly trends, top blocked domains, achievements, **opt-in local shareable snapshot** — produces a self-contained artefact the user chooses to publish; **no server, no referral tracking** (§7). |

## Configuration

No `NEXT_PUBLIC_*` or server-side variables exist. Configuration is build-time, exposed via
Vite's `import.meta.env` (only `VITE_`-prefixed vars reach the client).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VITE_GOOGLE_OAUTH_CLIENT_ID` | Yes | – | Public OAuth client id (PKCE; no secret). |
| `VITE_SCAN_WINDOW_DAYS` | No | `30` | Initial inbox scan window (see [design-gmail-integration.md](design-gmail-integration.md)). |

User settings are stored on-device (IndexedDB), not in build config or any server profile.
They are surfaced as toggles in the Settings screen and persisted via the core repository (§8):

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | `'light' \| 'dark' \| 'system'` | `'system'` | Theme preference. |
| `contributeToAggregate` | boolean | `true` | Opt-out of the deferred anonymous collective-trust aggregate (§9). |

## Error Handling

There is no app API, so errors are local or Google-originated. Surface them inline or as a
toast; never block the local-first UI on a network failure.

| Error | When | UX |
|-------|------|----|
| Offline / asset miss | Service worker has no cached response | App still launches from cache; show "Offline — Gmail sync paused; local data is available". |
| Token expired | Google access token (in-memory) lapsed | Prompt to re-consent (PKCE re-auth); pending local decisions are preserved. |
| Gmail quota near cap | Client-tracked usage approaches per-user limit | Warn and slow/pause scanning (see [design-gmail-integration.md](design-gmail-integration.md)); keep the UI responsive. |
| Gmail mutation failed (Execution) | A filter/unsubscribe/modify call fails | Mark that row failed in the completion summary; local decision remains the source of truth and is retried on next sync. |
| IndexedDB unavailable | Private-mode / storage blocked | Hard-fail with a clear explanation — the app cannot function without local storage. |

Recoverable Google calls are retried with backoff at the transport layer — a shared
`fetchWithRetry` wraps every Gmail/Drive `fetch`, honouring `Retry-After` and otherwise
using exponential backoff + jitter for 429 / 403 rate-limit / 5xx / 408 (see
[design-gmail-integration.md](design-gmail-integration.md) error table). Local decisions are
**idempotent and authoritative**, so a failed enforcement call never loses the user's intent.

## Examples

### Reactive read via the repository

```tsx
// apps/web/src/screens/Dashboard.tsx — the single decisions surface (Decision 8)
import { useLiveQuery } from 'dexie-react-hooks';
import { repo } from '@/core';

export function Dashboard() {
  const [tab, setTab] = useState<'pending' | 'decided' | 'all'>('pending');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('priority');
  const senders = useLiveQuery(() => repo.listDecisions({ tab, query, sort, groupByDomain }));
  if (!senders) return <DashboardSkeleton />;
  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      {/* Tabs carry the counts ("Pending 12"); plus search, sort, and group-by-domain (#104). */}
      <DecisionsToolbar tab={tab} onTab={setTab} onSearch={setQuery} onSort={setSort} />
      <DecisionsList senders={senders} onInline={applyDecisionInline} onOpen={openDetail} />
      {/* detail panel: right-side on desktop, bottom sheet on mobile */}
    </main>
  );
}
```

### Decision phase writing to the local pending list

```tsx
// apps/web/src/components/composed/trust-actions.tsx
function onBlock(sender: Sender, actions: BlockActions) {
  // Appends to the in-memory pending list; nothing touches Gmail until Execution.
  workflow.append({ senderId: sender.id, kind: 'block', actions });
  workflow.advance(); // surface the next highest-priority prompt
}
```

### Export / delete (privacy UX, §5)

```tsx
// Settings → Privacy
async function onExport() {
  const blob = await repo.exportAll();          // dump IndexedDB
  downloadBlob(blob, 'inbox-clinic-export.json');
}

async function onDeleteEverything() {
  await repo.deleteAllLocal();                   // clear all object stores
  await google.revokeAccess();                   // revoke the app's Google grant
  navigate('/goodbye');
}
```

## Accessibility & Responsive

Per the project accessibility baseline:

| Requirement | Implementation |
|-------------|----------------|
| Mobile-first, responsive | Two distinct shells — a touch-first single-column **mobile** layout and a sidebar **desktop** layout — chosen automatically by breakpoint and **user-pinnable** via the `LayoutSwitch` (Auto / Desktop / Mobile), remembered on-device. **Capacitor wrapper is a future target (§9)** so the mobile layout stays touch-first. |
| Colour + text/icon | Every colour-coded signal (score tier, status badge) also carries text/icon. |
| Keyboard navigable | Workflow phases, decision actions, and dialogs operable by keyboard; focus managed by `ui/` primitives. |
| Announced state | Progress and completion in Execution announced to screen readers (`aria-live`). |
| Touch targets | ≥44×44px for all interactive controls. |
| Alternative flows | Any batch decision can be done one-at-a-time (Discovery's "review individually"). |
| Reduced motion | Respect `prefers-reduced-motion`; transitions degrade to instant. |

## Migration Notes

This supersedes the Next.js frontend design. Removed concepts: SSR/static hybrid rendering,
server components, `NEXT_PUBLIC_*`/`API_URL` env vars, TanStack Query against our API,
admin dashboard routes, public status-page route, and middleware-based auth. Direct
component → Firestore/API access is replaced by the `packages/core` **repository** over
IndexedDB. There is no running implementation to migrate yet (Alpha).

## Open Questions

None — the previously-open items are now resolved:

- **Google-call fetching:** a thin core-owned **`fetchWithRetry`** (retry/backoff, in-flight
  handling) — **no** TanStack Query (Decision 3; IndexedDB + `useLiveQuery` already give
  reactive app state).
- **iOS background sync:** **on-open sync** is the accepted behaviour on iOS Safari (no
  Periodic Background Sync there); native background sync arrives with the deferred Capacitor
  wrap (Decision 4, §9).
- **Routing:** **history routing** via `react-router-dom` (clean, bookmarkable URLs; Cloudflare
  Pages SPA fallback) — **implemented (#102)**. The home surface's active decisions tab
  (`?tab=`) and an open detail (`?sender=`/`?domain=`) are **URL-controlled (#120)** via
  `useSearchParams`, merging params so `?demo=1` is preserved.
- **Shareable analytics snapshot format:** an Analytics concern — resolved as a **PNG image**
  in [design-analytics.md](design-analytics.md).

---

**Changelog:**

| Date | Change | Author |
|------|--------|--------|
| 2026-06-28 | Rewritten for the client-only, local-first, all-TypeScript PWA architecture (Vite + React + Tailwind, `packages/core`, Dexie/IndexedDB). Replaces the Next.js design. | Claude |
| 2026-07-05 | Add the **persistent application shell**: signed-in views share one header (brand, account, Dashboard/Analytics/Settings nav, Sync/Scan, offline indicator); screens become content-only. Navigation stays in-memory view state (URL router deferred). | Claude |
| 2026-07-05 | Add **Decision 7: the "Vitals" design system** — semantic CSS-variable tokens exposed through Tailwind v4 `@theme inline`; calm clinical teal palette; light + dark by `prefers-color-scheme` (system-detected). All components re-tokenised off raw palette colours. | Claude |
| 2026-07-05 | Split the shell into **two distinct layouts** (touch-first mobile top-bar vs. desktop **sidebar**), chosen by `useLayout` and **user-pinnable** via `LayoutSwitch` (Auto / Desktop / Mobile, persisted on-device; forced-desktop widens the viewport on small screens). Dashboard/Analytics go multi-column on desktop. | Claude |
| 2026-07-05 | Add **demo mode** — a no-Google `?demo` / "Explore the demo" entry that builds an ephemeral in-memory client trio from `@inboxclinic/core/demo` (seeded fixtures), with a persistent Demo banner + Exit. Doubles as the Tier-3 Playwright substrate. | Claude |
| 2026-07-05 | Add the **Decisions view** (nav: Dashboard · Decisions · Analytics · Settings): lists every trust/block, and **changing a decision** previews its impact then applies + reconciles filters (revisable decisions — replaces the dead "Past decisions" pointer). Extract a shared `ImpactPreview`. | Claude |
| 2026-07-05 | Settings gains a **Filter cleanup** card (`suggestFilterOptimisations` / `applyFilterOptimisations`): consolidate per-address rules into `*@domain`, drop duplicate/redundant filters — confirm-first. Extract shared filter-shape helpers; demo seeds messy legacy filters. | Claude |
| 2026-07-05 | Decisions view gains the **confirm-first import** of learned prior decisions (`learnPriorDecisions` → `importLearnedDecisions`): "Found N prior decisions" from existing filters + read-weighted Spam/Trash, imported as Blocked on request. Demo seeds Spam/Trash-only senders (the in-memory Gmail inbox scan now excludes Spam/Trash). | Claude |
| 2026-07-05 | Workflow optimisation: merge **Discovery + Decision → Triage** (actions inline; one tap or `T`/`B`/`D`/`S` per sender), **one-tap Block** with smart defaults + a Customize expander, and the **impact preview** in Review. Decision 6 is now three phases. | Claude |
| 2026-07-05 | Add **Decision 8: dashboard senders actionable in place via a `SenderDetail` drawer** (desktop right panel / mobile bottom sheet). Clicking any sender, pending row, or the Pending tile opens it; reuses `PromptCard` / `TrustActions` / `ImpactPreview` so Trust/Defer apply immediately and Block previews + confirms — closing the affordance/behaviour gap on the dashboard. | Claude |
| 2026-07-05 | Implement **transport-level retry/backoff** for Google calls: a shared `fetchWithRetry` wraps every Gmail/Drive `fetch` (Retry-After + exponential backoff/jitter for 429 / 403 rate-limit / 5xx / 408), replacing the earlier "TanStack Query if adopted" hedge in Error Handling. | Claude |
| 2026-07-06 | Add an **"Alpha" badge** in the app-shell brand and a **global Feedback trigger** (both shells) that opens the `ReportProblem` panel in a shared `Drawer` — inviting problem *and* improvement feedback from anywhere, not just Settings/error screens. Reframe the Settings card + prompts from "Report a problem" to welcome ideas. | Claude |
| 2026-07-05 | Extend Decision 8 to **domains**: a **Senders / Domains** segmented toggle on the dashboard list (switched by the summary tiles), a domains explorer, and a `DomainDetail` drawer (shared `ui/Drawer` shell) showing the aggregate, an averaged member score, drillable member senders, and a domain-scoped Trust/Block/Defer — closing the dead-end **Domains** count. | Claude |
| 2026-07-05 | Functional pass: replace the ambiguous **Sync/Scan** pair with one **Refresh** (incremental sync) + a last-synced/result indicator; move the full **Rescan** to Settings; add Settings **export / delete-all** data controls. | Claude |
| 2026-07-05 | UI review pass: Dashboard leads with an **inbox-health hero** (score + tone-tinted bar + the "Review N" primary action); senders reflow to a **card list on mobile** (was a clipped table) with **status chips**; tone-aware `ProgressBar`; **active nav** given a distinct accent treatment (was identical to hover). | Claude |
| 2026-07-16 | **Home-page redesign (proposal, #99):** make the home page one **searchable, sortable decisions surface** — a table on desktop / card list on mobile — with `Pending · Decided · All` tabs (counts in the labels), a **group-by-domain** toggle, a status column + **inline Trust/Block/Defer**, and row → detail **side-panel (desktop) / bottom sheet (mobile)** to view/change. **Remove** the standalone count tiles and the **inbox-health hero** from the home (health stays on Analytics). The guided workflow becomes an optional **"Triage pending →"** fast-path — primary on mobile, an escape hatch on desktop. Move the **`LayoutSwitch`** into the account menu. Add a **User Journeys** section; revise **Decision 8** and the shell/layout section; fixes the desktop pending-aside/table overlap. | Claude |
| 2026-07-16 | **Approved (Alpha):** the frontend design — including the #99 home-page decisions-surface redesign — is the authoritative source for its topic; changes now require discussion. Open Questions are deferred (not blockers). | Claude |
| 2026-07-16 | **Phased-delivery note (#106):** the decisions-surface rebuild (#100) ships **senders-only**; whole-domain decisions stay reachable via a sender's detail-panel scope toggle, and the **group-by-domain** toggle + `DomainDetail` are deferred to **#104**. The orphaned `DomainDetail` component was removed for now (git history preserves it) per the No-Dead-Code rule; #104 rebuilds it against the new surface. Doc synced to match: annotated Decision 8 (lead sentence, the group-by-domain bullet, the detail-panel bullet), User Journey #4, and the Screens table (dropped the now-deleted `DomainDetail`; marked the Domain explorer folded-in/#104). | Claude |
| 2026-07-16 | **#104 — group-by-domain shipped:** the deferred group-by-domain view landed — a **Group by domain** toggle on the home surface (domain aggregates with averaged member score, sender count, inline domain-scoped Trust/Block/Defer, and row → restored `DomainDetail` with member drill-in + per-address exceptions). The sender surface now resolves each sender's **effective** status (`resolveEffectiveDecision`) so a domain decision reflects on its members. Closes the #106 phase note; the "phased to #104" qualifiers are removed across Decision 8 and the Screens table. | Claude |
| 2026-07-16 | **#102 — history routing:** move navigation from in-memory view state to **`react-router-dom`** (routes `/`, `/triage`, `/analytics`, `/settings`; back/forward; unknown-path fallback to home; `?demo=1` preserved), served by the existing Cloudflare Pages SPA fallback (`_redirects`). Library chosen per architecture.md §1 *Use the ecosystem*. Linking the decisions tab / open detail into the URL is deferred to a follow-up. | Claude |
| 2026-07-17 | **Prior-block signals woven into the decision (#96, #97 — implemented):** `SenderDetail` renders an **inline flagged-siblings offer** (Block all / Keep all / Not now) when the open sender has same-domain spam/binned/filtered siblings; the workflow keeps its existing domain `BatchOffer`. The **learn pass runs on the home surface's mount** to populate the prior-block scoring signals (so flagged senders sort up), and the standalone **"Import all as Blocked" card is removed** (`PriorDecisionsImport` deleted). Semantics in design-trust-decisions.md Decision 8. | Claude |
| 2026-07-17 | **Prior-block signals woven into the decision (#96, #97 — design lock):** `SenderDetail` renders flagged same-domain siblings via the existing **`batch-offer`** (extended to *block this / all-flagged / domain* + mirrored *Keep* / *Not now*) with the reason in **`signal-list`**; the workflow reuses the compact form. Prior-block signals raise the **trust score** (score-sort) so flagged senders surface in normal triage; the standalone **"Import all as Blocked" card is removed**. Semantics in design-trust-decisions.md Decision 8. | Claude |
| 2026-07-18 | **#120 — deep-link the decisions surface:** the home surface's active tab (`?tab=decided\|all`) and an open detail (`?sender=<id>` / `?domain=<id>`) are now **URL-controlled** via `useSearchParams`. Tab changes **push** (bookmarkable; back/forward between tabs); an open detail is linkable but transient, so it **replaces** the history entry (only one opens at a time — `sender` wins if both are set). A deep link opens that tab/detail on load; closing clears the param; every setter merges so `?demo=1` survives. Closes the tab/detail follow-up left by #102. | Claude |
