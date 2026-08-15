// SPDX-License-Identifier: Apache-2.0
/**
 * The consolidated-consent invariant: a whole session must cost the user exactly one
 * consent prompt (docs/design-gmail-integration.md Decision 2, docs/design-testing.md
 * Decision 9 error table).
 *
 * This is a behavioural rule, not a constant — the old design escalated scopes inside
 * `listFilters`/`batchModifyMessages`, where nothing in a type signature said so. The
 * cheapest guard is to drive a realistic session end-to-end and count the prompts.
 */

import { describe, expect, it } from "vitest";

import { backupIfEnabled } from "../backup/backup";
import { applyDecisions } from "../decisions/applyDecision";
import { enforce } from "../enforcement/enforce";
import { GOOGLE_SCOPES } from "../ports/scopes";
import { runScan } from "../scan/runScan";
import {
  createInMemoryStore,
  inboxFromSender,
  MockBackupClient,
  MockGmailClient,
} from "../testing";

const NOW = 1_700_000_000_000;

/** Sign in, scan, decide, enforce, back up — everything a real session does. */
async function runFullSession(gmail: MockGmailClient, backup: MockBackupClient): Promise<void> {
  const store = createInMemoryStore();
  gmail.seedInbox(inboxFromSender("noise@spam.example", 5));

  await gmail.authenticate(); // sign-in
  await runScan(gmail, store);

  const senders = await store.senders.query({});
  await applyDecisions(
    store,
    senders.map((sender) => ({
      subjectId: sender.id,
      scope: "address" as const,
      decision: "block" as const,
      actions: ["create_filter" as const],
      now: NOW,
    })),
  );

  await enforce(gmail, store);
  await backupIfEnabled(backup, store);
}

describe("consolidated consent", () => {
  it("prompts exactly once for a full scan → decide → enforce → back up session", async () => {
    const gmail = new MockGmailClient();
    await runFullSession(gmail, new MockBackupClient());

    expect(gmail.authCalls).toHaveLength(1);
  });

  it("asks for every scope in that one prompt, including drive.file", async () => {
    const gmail = new MockGmailClient();
    await gmail.authenticate();

    expect(gmail.authCalls[0]).toEqual([...GOOGLE_SCOPES]);
  });

  it("re-authenticates with the full scope set, never a narrower one", async () => {
    const gmail = new MockGmailClient();
    await gmail.authenticate();
    gmail.setAuthExpired();

    const token = await gmail.getAccessToken();

    expect(gmail.authCalls).toHaveLength(2);
    expect(gmail.authCalls[1]).toEqual([...GOOGLE_SCOPES]);
    expect(token.grantedScopes).toEqual([...GOOGLE_SCOPES]);
  });

  it("does not re-prompt to read existing filters during the prior-decisions pass", async () => {
    // Reading filters needs gmail.settings.basic, which used to be a second prompt
    // triggered by a pass the user never initiated (design Decision 7).
    const gmail = new MockGmailClient();
    await gmail.authenticate();

    await gmail.listFilters();

    expect(gmail.authCalls).toHaveLength(1);
  });
});
