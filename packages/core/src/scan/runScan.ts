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
 * generate prompts for the undecided → update the profile counts. The History-API
 * marker (`lastHistoryId`) is a placeholder in M1; incremental sync arrives in M5.
 */

import { generatePrompts } from "../prompts/generatePrompts";
import { extractSenders } from "../senders/extract";
import type { GmailClient } from "../ports/GmailClient";
import type { Profile, Sender, Store } from "../store";

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
  const metas = await Promise.all(ids.map((id) => client.getMessageMeta(id)));

  const { senders, domains } = extractSenders(metas, now);

  // Preserve prior trust decisions across rescans; only undecided senders prompt.
  const priorStatus = new Map<string, Sender["trustStatus"]>();
  for (const prior of await store.senders.query({})) priorStatus.set(prior.id, prior.trustStatus);
  for (const sender of senders) {
    const prev = priorStatus.get(sender.id);
    if (prev !== undefined) sender.trustStatus = prev;
  }

  await store.senders.bulkPut(senders);
  await store.domains.bulkPut(domains);

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
