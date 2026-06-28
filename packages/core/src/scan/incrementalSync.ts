/**
 * Incremental sync orchestration — pure over the ports.
 *
 * See docs/design-gmail-integration.md (Decision 4: polling + History-API incremental
 * sync; Example 2: transparent rescan on a stale historyId) and docs/ROADMAP.md M5.
 * Like `runScan`, this depends only on the `GmailClient` and `Store` ports, so it is
 * exercised in tests with a `MockGmailClient` + an in-memory `Store` fake.
 *
 * Flow:
 *   - No stored `lastHistoryId` (first run) → full bounded scan (reuse `runScan`), then
 *     seed the marker from `getLatestHistoryId`.
 *   - Otherwise call `listHistory(lastHistoryId)` and process the deltas:
 *       • messagesAdded   → fetch metadata, extract senders, merge counts/signals into
 *                           the store, create new senders + prompts.
 *       • messagesDeleted → adjust the mailbox message count (ids are not attributable
 *                           to a sender without a per-message index; the bounded rescan
 *                           is the correction mechanism — Decision 4).
 *       • labelsChanged   → apply SPAM/STARRED signal deltas to the affected sender.
 *     then advance `lastHistoryId` to the mailbox's current historyId.
 *   - On a **stale** historyId (`StaleHistoryError` / 404) → transparently fall back to a
 *     bounded rescan and reseed the marker.
 *
 * After processing, native filters are reconciled from the durable blocked set (reusing
 * M4's idempotent `reconcileNativeFilters`) so re-syncing never duplicates filters.
 */

import { runScan } from "./runScan";
import { FILTER_SYNC_KEY, reconcileNativeFilters } from "../enforcement/enforce";
import { keyFor } from "../keys";
import { generatePrompts } from "../prompts/generatePrompts";
import { extractSenders, frequencyFor } from "../senders/extract";
import type { CompileFiltersOptions } from "../enforcement/compileFilters";
import type { GmailClient, MessageMeta } from "../ports/GmailClient";
import { StaleHistoryError } from "../ports/GmailClient";
import type { Domain, Sender, Store } from "../store";

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_LABEL_IDS = ["INBOX"];

export interface IncrementalSyncOptions {
  /** Bounded scan window in days (design default 30) — used for full scan / rescan. */
  windowDays?: number;
  /** Labels to scan / restrict history to (design default `['INBOX']`). */
  labelIds?: string[];
  /** Hard cap on messages fetched during a full scan / rescan. */
  maxMessages?: number;
  /** Injected clock for deterministic tests. */
  now?: number;
  /** Filter-compilation tuning passed through to reconciliation. */
  compile?: CompileFiltersOptions;
}

export interface IncrementalSyncResult {
  /** `full` on a first run or a stale-historyId rescan; `incremental` otherwise. */
  mode: "full" | "incremental";
  /** New messages scanned (full) or added since the last sync (incremental). */
  messagesAdded: number;
  /** Messages removed from the mailbox since the last sync (incremental only). */
  messagesRemoved: number;
  /** Label-change records processed (incremental only). */
  labelChanges: number;
  /** Senders newly discovered this sync. */
  sendersAdded: number;
  /** Existing senders whose counts/signals were updated this sync. */
  sendersUpdated: number;
  /** Prompts (re)generated for undecided senders touched this sync. */
  promptsGenerated: number;
  /** The historyId the marker advanced to. */
  historyId: string;
  /** True when a stale (404) marker forced a transparent bounded rescan. */
  rescanned: boolean;
  filtersCreated: number;
  filtersDeleted: number;
  totalFilters: number;
}

/**
 * Run an incremental Gmail sync, keeping the on-device store current without a full
 * rescan. Falls back to a bounded rescan on first run or a stale historyId. Pure over
 * the `GmailClient` + `Store` ports.
 */
export async function incrementalSync(
  client: GmailClient,
  store: Store,
  options: IncrementalSyncOptions = {},
): Promise<IncrementalSyncResult> {
  const now = options.now ?? Date.now();
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const labelIds = options.labelIds ?? DEFAULT_LABEL_IDS;

  const profile = await store.profile.get();
  if (profile === undefined || profile.lastHistoryId === null) {
    return fullSync(client, store, options, now, windowDays, labelIds, false);
  }

  const labelId = labelIds[0];
  let history;
  try {
    history = await client.listHistory(
      profile.lastHistoryId,
      labelId !== undefined ? { labelId } : undefined,
    );
  } catch (error) {
    if (error instanceof StaleHistoryError) {
      return fullSync(client, store, options, now, windowDays, labelIds, true);
    }
    throw error;
  }

  // Flatten the history records into id sets / label-delta lists.
  const addedIds: string[] = [];
  const removedIds = new Set<string>();
  const labelAdds: { id: string; labels: string[] }[] = [];
  const labelRemoves: { id: string; labels: string[] }[] = [];
  for (const record of history.records) {
    for (const a of record.messagesAdded ?? []) addedIds.push(a.message.id);
    for (const d of record.messagesDeleted ?? []) removedIds.add(d.message.id);
    for (const la of record.labelsAdded ?? [])
      labelAdds.push({ id: la.message.id, labels: la.labelIds });
    for (const lr of record.labelsRemoved ?? [])
      labelRemoves.push({ id: lr.message.id, labels: lr.labelIds });
  }

  // A message added then deleted within the window is a no-op; net it out and dedupe.
  const netAdded = [...new Set(addedIds)].filter((id) => !removedIds.has(id));
  const netAddedSet = new Set(netAdded);

  // 1. Added messages → fetch metadata (best-effort) and extract sender deltas.
  const addedMetas: MessageMeta[] = [];
  for (const id of netAdded) {
    try {
      addedMetas.push(await client.getMessageMeta(id));
    } catch {
      // The message may have moved/been deleted between history and fetch — skip it.
    }
  }
  const { senders: deltaSenders } = extractSenders(addedMetas, now);

  let sendersAdded = 0;
  let sendersUpdated = 0;
  const touchedPendingIds = new Set<string>();
  const affectedDomains = new Set<string>();
  for (const delta of deltaSenders) {
    const existing = await store.senders.get(delta.id);
    if (existing === undefined) {
      await store.senders.put(delta);
      sendersAdded += 1;
      touchedPendingIds.add(delta.id);
    } else {
      const merged = mergeSender(existing, delta, now);
      await store.senders.put(merged);
      sendersUpdated += 1;
      if (merged.trustStatus === "pending") touchedPendingIds.add(merged.id);
    }
    affectedDomains.add(delta.domain);
  }

  // 2. Label changes → apply SPAM/STARRED signal deltas to the attributed sender.
  let labelChanges = 0;
  for (const { id, labels } of labelAdds) {
    labelChanges += 1;
    await applyLabelDelta(client, store, id, labels, netAddedSet, now, +1);
  }
  for (const { id, labels } of labelRemoves) {
    labelChanges += 1;
    await applyLabelDelta(client, store, id, labels, netAddedSet, now, -1);
  }

  // 3. Recompute aggregates for affected domains from the merged sender set.
  if (affectedDomains.size > 0) {
    const allSenders = await store.senders.query({});
    const byDomain = new Map<string, { senderCount: number; totalEmails: number }>();
    for (const sender of allSenders) {
      const agg = byDomain.get(sender.domain) ?? { senderCount: 0, totalEmails: 0 };
      agg.senderCount += 1;
      agg.totalEmails += sender.totalEmails;
      byDomain.set(sender.domain, agg);
    }
    for (const domain of affectedDomains) {
      const agg = byDomain.get(domain) ?? { senderCount: 0, totalEmails: 0 };
      const existing = await store.domains.get(keyFor(domain));
      await store.domains.put(
        existing === undefined
          ? newDomain(domain, agg.senderCount, agg.totalEmails, now)
          : {
              ...existing,
              senderCount: agg.senderCount,
              totalEmails: agg.totalEmails,
              updatedAt: now,
            },
      );
    }
  }

  // 4. Regenerate prompts for the undecided senders touched this sync.
  const allSenders = await store.senders.query({});
  const touched = allSenders.filter((s) => touchedPendingIds.has(s.id));
  const prompts = generatePrompts(touched, { now });
  await store.prompts.bulkPut(prompts);

  // 5. Advance the marker and refresh profile counts.
  const finalDomains = await store.domains.query({});
  const messageCount = Math.max(0, profile.messageCount + addedMetas.length - removedIds.size);
  await store.profile.put({
    ...profile,
    lastHistoryId: history.historyId,
    senderCount: allSenders.length,
    domainCount: finalDomains.length,
    messageCount,
  });

  // 6. Keep native filters consistent with the durable blocked set (idempotent).
  const filters = await reconcileNativeFilters(client, store, options.compile);
  await store.filterSync.put({
    key: FILTER_SYNC_KEY,
    lastSyncAt: now,
    totalFilters: filters.totalFilters,
  });

  return {
    mode: "incremental",
    messagesAdded: addedMetas.length,
    messagesRemoved: removedIds.size,
    labelChanges,
    sendersAdded,
    sendersUpdated,
    promptsGenerated: prompts.length,
    historyId: history.historyId,
    rescanned: false,
    filtersCreated: filters.filtersCreated,
    filtersDeleted: filters.filtersDeleted,
    totalFilters: filters.totalFilters,
  };
}

/** First-run / stale-recovery path: bounded rescan, then reseed the marker. */
async function fullSync(
  client: GmailClient,
  store: Store,
  options: IncrementalSyncOptions,
  now: number,
  windowDays: number,
  labelIds: string[],
  rescanned: boolean,
): Promise<IncrementalSyncResult> {
  const scan = await runScan(client, store, {
    windowDays,
    labelIds,
    now,
    ...(options.maxMessages !== undefined ? { maxMessages: options.maxMessages } : {}),
  });

  const historyId = await client.getLatestHistoryId();
  const profile = await store.profile.get();
  if (profile !== undefined) {
    await store.profile.put({ ...profile, lastHistoryId: historyId });
  }

  const filters = await reconcileNativeFilters(client, store, options.compile);
  await store.filterSync.put({
    key: FILTER_SYNC_KEY,
    lastSyncAt: now,
    totalFilters: filters.totalFilters,
  });

  return {
    mode: "full",
    messagesAdded: scan.messageCount,
    messagesRemoved: 0,
    labelChanges: 0,
    sendersAdded: scan.senderCount,
    sendersUpdated: 0,
    promptsGenerated: scan.promptCount,
    historyId,
    rescanned,
    filtersCreated: filters.filtersCreated,
    filtersDeleted: filters.filtersDeleted,
    totalFilters: filters.totalFilters,
  };
}

/**
 * Apply a +1/-1 SPAM/STARRED signal delta to the sender that owns message `id`.
 * Skipped for newly-added messages (already counted from their fetched metadata) and
 * when the labels carry no signal we track. Best-effort: an unfetchable message is
 * ignored.
 */
async function applyLabelDelta(
  client: GmailClient,
  store: Store,
  id: string,
  labels: string[],
  netAddedSet: Set<string>,
  now: number,
  sign: 1 | -1,
): Promise<void> {
  if (netAddedSet.has(id)) return;
  const touchesSpam = labels.includes("SPAM");
  const touchesStarred = labels.includes("STARRED");
  if (!touchesSpam && !touchesStarred) return;

  let meta: MessageMeta;
  try {
    meta = await client.getMessageMeta(id);
  } catch {
    return;
  }
  const from = meta.headers.from;
  if (from === undefined) return;
  const parsed = parseSenderId(from);
  if (parsed === null) return;
  const sender = await store.senders.get(parsed);
  if (sender === undefined) return;

  await store.senders.put({
    ...sender,
    spamMarkedCount: touchesSpam
      ? Math.max(0, sender.spamMarkedCount + sign)
      : sender.spamMarkedCount,
    starredCount: touchesStarred ? Math.max(0, sender.starredCount + sign) : sender.starredCount,
    updatedAt: now,
  });
}

/** Derive a sender id (`keyFor(email)`) from a `From` header, or `null` if unparseable. */
function parseSenderId(from: string): string | null {
  const angle = /<([^>]+)>/.exec(from);
  const address = (angle?.[1] ?? from).trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  return keyFor(address);
}

/** Merge a freshly-extracted sender delta (new messages only) into a stored sender. */
function mergeSender(existing: Sender, delta: Sender, now: number): Sender {
  const totalEmails = existing.totalEmails + delta.totalEmails;
  const existingUnread =
    existing.readRate === null ? 0 : Math.round((1 - existing.readRate) * existing.totalEmails);
  const deltaUnread =
    delta.readRate === null ? 0 : Math.round((1 - delta.readRate) * delta.totalEmails);
  const unread = existingUnread + deltaUnread;

  const recencyBuckets = {
    d30: existing.recencyBuckets.d30 + delta.recencyBuckets.d30,
    d90: existing.recencyBuckets.d90 + delta.recencyBuckets.d90,
    d180: existing.recencyBuckets.d180 + delta.recencyBuckets.d180,
    older: existing.recencyBuckets.older + delta.recencyBuckets.older,
  };
  const deltaHasAuth = delta.auth.spf || delta.auth.dkim || delta.auth.dmarc || delta.auth.spoofed;

  return {
    ...existing,
    displayName: existing.displayName ?? delta.displayName,
    totalEmails,
    hasListUnsubscribe: existing.hasListUnsubscribe || delta.hasListUnsubscribe,
    hasListId: existing.hasListId || delta.hasListId,
    firstSeenAt: Math.min(existing.firstSeenAt, delta.firstSeenAt),
    lastSeenAt: Math.max(existing.lastSeenAt, delta.lastSeenAt),
    updatedAt: now,
    readRate: totalEmails > 0 ? 1 - unread / totalEmails : null,
    starredCount: existing.starredCount + delta.starredCount,
    spamMarkedCount: existing.spamMarkedCount + delta.spamMarkedCount,
    frequency: frequencyFor(recencyBuckets.d30),
    recencyBuckets,
    auth: deltaHasAuth && delta.lastSeenAt >= existing.lastSeenAt ? delta.auth : existing.auth,
  };
}

/** Build a fresh pending `Domain` aggregate (no prior decision). */
function newDomain(domain: string, senderCount: number, totalEmails: number, now: number): Domain {
  return {
    id: keyFor(domain),
    domain,
    trustStatus: "pending",
    senderCount,
    totalEmails,
    exceptionAddresses: [],
    updatedAt: now,
    trustDecidedAt: null,
    decisionScope: null,
    decisionContext: null,
    pendingActions: [],
  };
}
