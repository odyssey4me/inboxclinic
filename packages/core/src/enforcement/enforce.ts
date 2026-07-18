// SPDX-License-Identifier: Apache-2.0
/**
 * Enforcement orchestration — applies on-device decisions to Gmail.
 *
 * See docs/design-gmail-integration.md Decision 5 (best-effort, idempotent filter
 * reconciliation; the local decision is the source of truth) and design-trust-
 * decisions.md (block actions + Trust rescue). `enforce` depends only on the
 * `GmailClient` and `Store` ports, so it is exercised in tests with a `MockGmailClient`
 * and the in-memory `Store` fake.
 *
 * Two kinds of work, with different idempotency mechanisms:
 *
 * 1. **Native filters** are reconciled from the *durable* blocked set (every blocked
 *    sender/domain), not from `pendingActions`. Re-running yields no ops because the
 *    desired set already matches Gmail's filters.
 * 2. **One-time message actions** (archive/trash existing mail, unsubscribe) are driven
 *    by `pendingActions`, which are **cleared** once applied — so a re-run does nothing.
 *    Trust rescues (remove SPAM/TRASH) are gated by `spamMarkedCount`, which is zeroed
 *    after a successful rescue (the messages are genuinely no longer spam-marked). Both
 *    are only cleared once the matching-message fetch is confirmed exhausted (below the
 *    ceiling documented at {@link DEFAULT_MESSAGE_ID_CEILING}) — otherwise a follow-up
 *    run retries the remainder instead of the state being dropped silently.
 *
 * Everything is best-effort: per-subject failures are collected and do not abort the run.
 */

import { compileFilters, reconcileFilters, type CompileFiltersOptions } from "./compileFilters";
import { planActions } from "./planActions";
import { recordDailyAnalytics } from "../analytics/record";
import { effectiveBlockedDomains, effectiveBlockedSenders } from "../decisions/effectiveStatus";
import type { GmailClient } from "../ports/GmailClient";
import type { BlockAction, Store } from "../store";

/** Singleton key for the `filterSyncState` record. */
export const FILTER_SYNC_KEY = "filterSyncState";

/**
 * Ceiling passed as `max` to `listMessageIdsForSender`. `listMessageIds` pages via
 * cursor up to this many ids, so anything below it means the query is genuinely
 * exhausted (no `nextPageToken` left); anything landing exactly on it is treated as
 * "there may be more" — pendingActions / spamMarkedCount are left in place so a later
 * run retries rather than silently dropping the remainder.
 */
const DEFAULT_MESSAGE_ID_CEILING = 5000;

export interface EnforceOptions {
  /** Injected clock for deterministic tests. */
  now?: number;
  /** Filter-compilation tuning (threshold / OR-combine / soft cap). */
  compile?: CompileFiltersOptions;
  /** Override for {@link DEFAULT_MESSAGE_ID_CEILING} (tests only). */
  messageIdCeiling?: number;
}

export interface EnforceFailure {
  subject: string;
  error: string;
}

export interface EnforceResult {
  filtersCreated: number;
  filtersDeleted: number;
  /** Existing messages relabelled out of the inbox (archive). */
  messagesArchived: number;
  /** Existing messages sent to Trash (delete). */
  messagesTrashed: number;
  /** Existing messages pulled out of SPAM/TRASH (Trust rescue). */
  messagesRescued: number;
  /** Subjects for which an unsubscribe was requested (List-Unsubscribe present). */
  unsubscribeRequested: number;
  /** Filter count after reconciliation, for the soft-cap headroom view. */
  totalFilters: number;
  /** True when the desired filter set hit the ~450 soft cap. */
  capReached: boolean;
  /** Filters not created because the cap was reached. */
  skippedAtCap: number;
  failures: EnforceFailure[];
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Outcome of reconciling the durable blocked set against the account's native filters. */
export interface FilterReconcileOutcome {
  filtersCreated: number;
  filtersDeleted: number;
  /** Filter count after reconciliation, for the soft-cap headroom view. */
  totalFilters: number;
  /** True when the desired filter set hit the ~450 soft cap. */
  capReached: boolean;
  /** Filters not created because the cap was reached. */
  skippedAtCap: number;
  /** Ids of filters this app owns after this run — persist to `store.filterSync` (#29). */
  managedFilterIds: string[];
  failures: EnforceFailure[];
}

/**
 * Reconcile native Gmail filters from the *durable* blocked set (every blocked
 * sender/domain), not from `pendingActions`. Idempotent: re-running yields no ops once
 * Gmail already matches the desired set, so it is safe to call on every sync (M5) as
 * well as during enforcement (M4). Best-effort: per-filter failures are collected.
 */
export async function reconcileNativeFilters(
  client: GmailClient,
  store: Store,
  options: CompileFiltersOptions = {},
): Promise<FilterReconcileOutcome> {
  const failures: EnforceFailure[] = [];
  // The *effective* blocked set — a sender the user has trusted at the domain level is
  // excluded (unless it's an exception), so its filter is dropped rather than kept alive (#144).
  const blockedSenders = await effectiveBlockedSenders(store);
  const blockedDomains = await effectiveBlockedDomains(store);
  const compiled = compileFilters(
    blockedSenders,
    blockedDomains.map((d) => ({ domain: d.domain.domain, excludeAddresses: d.excludeAddresses })),
    options,
  );

  let filtersCreated = 0;
  let filtersDeleted = 0;
  // Preserve the last known-good count so a transient listFilters() failure below
  // doesn't corrupt the persisted soft-cap headroom view with a false "zero" reading.
  const previousSync = await store.filterSync.get();
  let totalFilters = previousSync?.totalFilters ?? 0;
  let managedFilterIds = new Set(previousSync?.managedFilterIds ?? []);
  try {
    const existing = await client.listFilters();
    // Drop ids for filters removed outside the app (e.g. via Gmail's own UI) so the
    // managed set tracks what's actually there instead of growing unbounded.
    const existingIds = new Set(existing.map((f) => f.id));
    managedFilterIds = new Set([...managedFilterIds].filter((id) => existingIds.has(id)));
    const { toCreate, toDelete } = reconcileFilters(compiled.filters, existing, managedFilterIds);
    for (const spec of toCreate) {
      try {
        const created = await client.createFilter(spec);
        managedFilterIds.add(created.id);
        filtersCreated += 1;
      } catch (error) {
        failures.push({ subject: `filter:${spec.from}`, error: errMsg(error) });
      }
    }
    for (const id of toDelete) {
      try {
        await client.deleteFilter(id);
        managedFilterIds.delete(id);
        filtersDeleted += 1;
      } catch (error) {
        failures.push({ subject: `filter:${id}`, error: errMsg(error) });
      }
    }
    totalFilters = existing.length - filtersDeleted + filtersCreated;
  } catch (error) {
    failures.push({ subject: "filters", error: errMsg(error) });
  }

  return {
    filtersCreated,
    filtersDeleted,
    totalFilters,
    capReached: compiled.capReached,
    skippedAtCap: compiled.skippedAtCap,
    managedFilterIds: [...managedFilterIds],
    failures,
  };
}

interface MessageSubject {
  from: string;
  /** Addresses to exclude from the `from` sweep (a domain's trusted exceptions, #145). */
  excludeFrom?: string;
  pendingActions: BlockAction[];
  hasListUnsubscribe: boolean;
  clear: () => Promise<void>;
}

/**
 * Reconcile native filters, apply staged message actions, rescue trusted senders, and
 * record sync state. Returns a summary of what changed. Idempotent and best-effort.
 */
export async function enforce(
  client: GmailClient,
  store: Store,
  options: EnforceOptions = {},
): Promise<EnforceResult> {
  const now = options.now ?? Date.now();
  const failures: EnforceFailure[] = [];

  const blockedSenders = await effectiveBlockedSenders(store);
  const blockedDomains = await effectiveBlockedDomains(store);

  // 1. Native filters — reconcile the durable block set against Gmail.
  const filters = await reconcileNativeFilters(client, store, options.compile);
  const { filtersCreated, filtersDeleted, totalFilters } = filters;
  failures.push(...filters.failures);

  // 2. One-time message actions for blocked subjects with staged pendingActions.
  const subjects: MessageSubject[] = [];
  for (const sender of blockedSenders) {
    if (sender.pendingActions.length === 0) continue;
    subjects.push({
      from: sender.email,
      pendingActions: sender.pendingActions,
      hasListUnsubscribe: sender.hasListUnsubscribe,
      clear: () => store.senders.put({ ...sender, pendingActions: [] }),
    });
  }
  for (const target of blockedDomains) {
    const domain = target.domain;
    if (domain.pendingActions.length === 0) continue;
    subjects.push({
      from: `*@${domain.domain}`,
      // Skip the domain's trusted exception addresses in the existing-mail sweep (#145).
      ...(target.excludeAddresses.length > 0
        ? { excludeFrom: target.excludeAddresses.join(" OR ") }
        : {}),
      pendingActions: domain.pendingActions,
      hasListUnsubscribe: false,
      clear: () => store.domains.put({ ...domain, pendingActions: [] }),
    });
  }

  const messageIdCeiling = options.messageIdCeiling ?? DEFAULT_MESSAGE_ID_CEILING;

  let messagesArchived = 0;
  let messagesTrashed = 0;
  let unsubscribeRequested = 0;
  for (const subject of subjects) {
    try {
      const plan = planActions({
        decision: "block",
        actions: subject.pendingActions,
        hasListUnsubscribe: subject.hasListUnsubscribe,
      });
      let drained = true;
      if (plan.messageMutation !== null) {
        const ids = await client.listMessageIdsForSender(
          subject.from,
          messageIdCeiling,
          subject.excludeFrom,
        );
        if (ids.length > 0) await client.batchModifyMessages(ids, plan.messageMutation);
        if (plan.messageMutation.addLabelIds?.includes("TRASH") === true) {
          messagesTrashed += ids.length;
        } else if (plan.messageMutation.removeLabelIds?.includes("INBOX") === true) {
          messagesArchived += ids.length;
        }
        drained = ids.length < messageIdCeiling;
      }
      if (plan.unsubscribe) unsubscribeRequested += 1;
      if (drained) {
        await subject.clear();
      } else {
        // More matching messages than the ceiling — leave pendingActions in place so a
        // follow-up run picks up the remainder instead of silently dropping it.
        failures.push({
          subject: subject.from,
          error: `more than ${messageIdCeiling} matching messages; pendingActions retained for a follow-up run`,
        });
      }
    } catch (error) {
      failures.push({ subject: subject.from, error: errMsg(error) });
    }
  }

  // 3. Trust rescue — pull spam-marked trusted senders back out of SPAM/TRASH.
  // NOTE: reads raw trustStatus, not effective — a sender trusted only via a domain override
  // (raw status still "blocked") is not rescued here yet. Tracked as a follow-up in #146.
  let messagesRescued = 0;
  const trustedSenders = await store.senders.query({ trustStatus: "trusted" });
  for (const sender of trustedSenders) {
    if (sender.spamMarkedCount <= 0) continue;
    try {
      const plan = planActions({ decision: "trust", spamMarkedCount: sender.spamMarkedCount });
      let drained = true;
      if (plan.messageMutation !== null) {
        const ids = await client.listMessageIdsForSender(sender.email, messageIdCeiling);
        if (ids.length > 0) await client.batchModifyMessages(ids, plan.messageMutation);
        messagesRescued += ids.length;
        drained = ids.length < messageIdCeiling;
      }
      if (drained) {
        await store.senders.put({ ...sender, spamMarkedCount: 0 });
      } else {
        // More spam-marked messages than the ceiling — leave the counter in place so a
        // follow-up run retries rescuing the remainder.
        failures.push({
          subject: sender.email,
          error: `more than ${messageIdCeiling} spam-marked messages; spamMarkedCount retained for a follow-up run`,
        });
      }
    } catch (error) {
      failures.push({ subject: sender.email, error: errMsg(error) });
    }
  }

  // 4. Record sync state and the day's blocked/rescued email volume (analytics, M6).
  await store.filterSync.put({
    key: FILTER_SYNC_KEY,
    lastSyncAt: now,
    totalFilters,
    managedFilterIds: filters.managedFilterIds,
  });
  await recordDailyAnalytics(store, now, {
    emailsBlocked: messagesArchived + messagesTrashed,
    emailsRescued: messagesRescued,
  });

  return {
    filtersCreated,
    filtersDeleted,
    messagesArchived,
    messagesTrashed,
    messagesRescued,
    unsubscribeRequested,
    totalFilters,
    capReached: filters.capReached,
    skippedAtCap: filters.skippedAtCap,
    failures,
  };
}
