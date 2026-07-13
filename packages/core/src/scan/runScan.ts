// SPDX-License-Identifier: Apache-2.0
/**
 * Bounded metadata scan orchestration — pure over the ports.
 *
 * See docs/design-gmail-integration.md (Decision 3, metadata-only bounded scan) and
 * docs/ROADMAP.md M1. `runScan` depends only on the `GmailClient` and `Store` ports,
 * so it is exercised in tests with a `MockGmailClient` + an in-memory `Store` fake,
 * and in the app with the browser adapters.
 *
 * Flow: build a bounded Gmail query → list ids → fetch each message's metadata →
 * extract senders/domains → upsert them (preserving prior trust decisions) →
 * generate prompts for the undecided → update the profile counts. `runScan` is also the
 * first-run / stale-recovery path for `incrementalSync` (scan/incrementalSync.ts), which
 * seeds the History-API marker (`lastHistoryId`) from `getLatestHistoryId` afterwards.
 */

import { recordDailyAnalytics } from "../analytics/record";
import { generatePrompts } from "../prompts/generatePrompts";
import { extractSenders } from "../senders/extract";
import type { GmailClient, MessageMeta } from "../ports/GmailClient";
import type { Domain, Profile, Sender, Store } from "../store";

export interface RunScanOptions {
  /** Bounded scan window in days (design default 30). */
  windowDays?: number;
  /** Labels to scan (design default `['INBOX']`). */
  labelIds?: string[];
  /** Hard cap on messages fetched in one scan. */
  maxMessages?: number;
  /** Signed-in account address; falls back to the client / existing profile. */
  accountEmail?: string;
  /** Injected clock for deterministic tests. */
  now?: number;
}

export interface ScanResult {
  messageCount: number;
  senderCount: number;
  domainCount: number;
  promptCount: number;
}

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_LABEL_IDS = ["INBOX"];
const DEFAULT_MAX_MESSAGES = 500;

/** Translate a label id into its Gmail search-query equivalent. */
function labelToQuery(labelId: string): string {
  if (labelId === "INBOX") return "in:inbox";
  return `label:${labelId.toLowerCase()}`;
}

/** Build the bounded metadata-scan query from the window and labels. */
export function buildScanQuery(windowDays: number, labelIds: string[]): string {
  const parts = labelIds.map(labelToQuery);
  parts.push(`newer_than:${windowDays}d`);
  return parts.join(" ");
}

/**
 * Run a bounded, metadata-only inbox scan and persist the extracted senders and
 * domains, then refresh the profile counts. Returns a summary of what was scanned.
 */
export async function runScan(
  client: GmailClient,
  store: Store,
  options: RunScanOptions = {},
): Promise<ScanResult> {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const labelIds = options.labelIds ?? DEFAULT_LABEL_IDS;
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const now = options.now ?? Date.now();

  const query = buildScanQuery(windowDays, labelIds);
  const ids = await client.listMessageIds(query, maxMessages);
  // Best-effort per message: one that moved/was deleted since listing shouldn't abort
  // the whole scan (mirrors incrementalSync.ts's per-message try/catch).
  const settled = await Promise.allSettled(ids.map((id) => client.getMessageMeta(id)));
  const metas = settled
    .filter((r): r is PromiseFulfilledResult<MessageMeta> => r.status === "fulfilled")
    .map((r) => r.value);
  // Every fetch failing (e.g. an expired token) is a systemic problem, not a flaky
  // message — surface it instead of silently reporting an empty scan as a success.
  if (ids.length > 0 && metas.length === 0) {
    const [firstFailure] = settled as PromiseRejectedResult[];
    throw new Error("runScan: failed to fetch any message metadata", {
      cause: firstFailure?.reason,
    });
  }

  const { senders, domains } = extractSenders(metas, now);

  // Preserve prior trust decisions across rescans; only undecided senders/domains
  // prompt. Every decision-record field is carried forward (not just `trustStatus`),
  // otherwise a rescan silently wipes a blocked sender's `pendingActions` before
  // enforce() picks them up, or reverts a blocked domain straight back to `pending`.
  const priorSenders = new Map<string, Sender>();
  for (const prior of await store.senders.query({})) priorSenders.set(prior.id, prior);
  const newSenders = senders.filter((s) => !priorSenders.has(s.id)).length;
  for (const sender of senders) {
    const prev = priorSenders.get(sender.id);
    if (prev === undefined) continue;
    sender.trustStatus = prev.trustStatus;
    sender.trustDecidedAt = prev.trustDecidedAt;
    sender.decisionScope = prev.decisionScope;
    sender.decisionContext = prev.decisionContext;
    sender.pendingActions = prev.pendingActions;
  }

  const priorDomains = new Map<string, Domain>();
  for (const prior of await store.domains.query({})) priorDomains.set(prior.id, prior);
  for (const domain of domains) {
    const prev = priorDomains.get(domain.id);
    if (prev === undefined) continue;
    domain.trustStatus = prev.trustStatus;
    domain.trustDecidedAt = prev.trustDecidedAt;
    domain.decisionScope = prev.decisionScope;
    domain.decisionContext = prev.decisionContext;
    domain.pendingActions = prev.pendingActions;
    domain.exceptionAddresses = prev.exceptionAddresses;
  }

  await store.senders.bulkPut(senders);
  await store.domains.bulkPut(domains);
  await recordDailyAnalytics(store, now, { newSenders });

  const prompts = generatePrompts(senders, { now });
  await store.prompts.bulkPut(prompts);

  const existing = await store.profile.get();
  const accountEmail =
    options.accountEmail ?? existing?.googleEmail ?? (await client.getAccountEmail());

  const profile: Profile = {
    googleEmail: accountEmail,
    onboardingComplete: existing?.onboardingComplete ?? false,
    lastHistoryId: existing?.lastHistoryId ?? null,
    senderCount: senders.length,
    domainCount: domains.length,
    messageCount: metas.length,
    lastScanAt: now,
    privacy: existing?.privacy ?? { contributeToAggregate: true },
  };
  await store.profile.put(profile);

  return {
    messageCount: metas.length,
    senderCount: senders.length,
    domainCount: domains.length,
    promptCount: prompts.length,
  };
}
