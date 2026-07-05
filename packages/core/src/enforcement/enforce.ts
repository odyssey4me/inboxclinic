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
 *    after a successful rescue (the messages are genuinely no longer spam-marked).
 *
 * Everything is best-effort: per-subject failures are collected and do not abort the run.
 */

import { compileFilters, reconcileFilters, type CompileFiltersOptions } from "./compileFilters";
import { planActions } from "./planActions";
import { recordDailyAnalytics } from "../analytics/record";
import type { GmailClient } from "../ports/GmailClient";
import type { BlockAction, Store } from "../store";

/** Singleton key for the `filterSyncState` record. */
export const FILTER_SYNC_KEY = "filterSyncState";

export interface EnforceOptions {
  /** Injected clock for deterministic tests. */
  now?: number;
  /** Filter-compilation tuning (threshold / OR-combine / soft cap). */
  compile?: CompileFiltersOptions;
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
  const blockedSenders = await store.senders.query({ trustStatus: "blocked" });
  const blockedDomains = await store.domains.query({ trustStatus: "blocked" });
  const compiled = compileFilters(blockedSenders, blockedDomains, options);

  let filtersCreated = 0;
  let filtersDeleted = 0;
  let totalFilters = 0;
  try {
    const existing = await client.listFilters();
    const { toCreate, toDelete } = reconcileFilters(compiled.filters, existing);
    for (const spec of toCreate) {
      try {
        await client.createFilter(spec);
        filtersCreated += 1;
      } catch (error) {
        failures.push({ subject: `filter:${spec.from}`, error: errMsg(error) });
      }
    }
    for (const id of toDelete) {
      try {
        await client.deleteFilter(id);
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
    failures,
  };
}

interface MessageSubject {
  from: string;
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

  const blockedSenders = await store.senders.query({ trustStatus: "blocked" });
  const blockedDomains = await store.domains.query({ trustStatus: "blocked" });

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
  for (const domain of blockedDomains) {
    if (domain.pendingActions.length === 0) continue;
    subjects.push({
      from: `*@${domain.domain}`,
      pendingActions: domain.pendingActions,
      hasListUnsubscribe: false,
      clear: () => store.domains.put({ ...domain, pendingActions: [] }),
    });
  }

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
      if (plan.messageMutation !== null) {
        const ids = await client.listMessageIdsForSender(subject.from);
        if (ids.length > 0) await client.batchModifyMessages(ids, plan.messageMutation);
        if (plan.messageMutation.addLabelIds?.includes("TRASH") === true) {
          messagesTrashed += ids.length;
        } else if (plan.messageMutation.removeLabelIds?.includes("INBOX") === true) {
          messagesArchived += ids.length;
        }
      }
      if (plan.unsubscribe) unsubscribeRequested += 1;
      await subject.clear();
    } catch (error) {
      failures.push({ subject: subject.from, error: errMsg(error) });
    }
  }

  // 3. Trust rescue — pull spam-marked trusted senders back out of SPAM/TRASH.
  let messagesRescued = 0;
  const trustedSenders = await store.senders.query({ trustStatus: "trusted" });
  for (const sender of trustedSenders) {
    if (sender.spamMarkedCount <= 0) continue;
    try {
      const plan = planActions({ decision: "trust", spamMarkedCount: sender.spamMarkedCount });
      if (plan.messageMutation !== null) {
        const ids = await client.listMessageIdsForSender(sender.email);
        if (ids.length > 0) await client.batchModifyMessages(ids, plan.messageMutation);
        messagesRescued += ids.length;
      }
      await store.senders.put({ ...sender, spamMarkedCount: 0 });
    } catch (error) {
      failures.push({ subject: sender.email, error: errMsg(error) });
    }
  }

  // 4. Record sync state and the day's blocked/rescued email volume (analytics, M6).
  await store.filterSync.put({ key: FILTER_SYNC_KEY, lastSyncAt: now, totalFilters });
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
