// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { enforce } from "../enforcement/enforce";
import { keyFor } from "../keys";
import { createInMemoryStore, MockGmailClient, senderBuilder } from "../testing";
import { importLearnedDecisions } from "./importLearned";

const NOW = Date.UTC(2026, 6, 5);

describe("importLearnedDecisions", () => {
  it("creates a blocked record for a spam subject not yet in the store", async () => {
    const store = createInMemoryStore();

    const count = await importLearnedDecisions(
      store,
      [
        {
          subjectId: keyFor("wins@casino.example"),
          scope: "address",
          label: "wins@casino.example",
          reason: "spam",
          messageCount: 5,
          unreadShare: null,
        },
      ],
      NOW,
    );

    expect(count).toBe(1);
    const sender = await store.senders.get(keyFor("wins@casino.example"));
    expect(sender?.trustStatus).toBe("blocked");
    expect(sender?.pendingActions).toEqual(["create_filter"]);
  });

  it("blocks an existing (pending) subject in place", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("news@x.com"));

    await importLearnedDecisions(
      store,
      [
        {
          subjectId: keyFor("news@x.com"),
          scope: "address",
          label: "news@x.com",
          reason: "filter",
          messageCount: 0,
          unreadShare: null,
        },
      ],
      NOW,
    );

    expect((await store.senders.get(keyFor("news@x.com")))?.trustStatus).toBe("blocked");
  });

  it("imported blocks enforce into native filters", async () => {
    const store = createInMemoryStore();
    const gmail = new MockGmailClient();

    await importLearnedDecisions(
      store,
      [
        {
          subjectId: keyFor("junk@spam.example"),
          scope: "address",
          label: "junk@spam.example",
          reason: "spam",
          messageCount: 3,
          unreadShare: null,
        },
      ],
      NOW,
    );
    await enforce(gmail, store, { now: NOW });

    expect(gmail.createdFilters).toEqual([
      { from: "junk@spam.example", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
  });

  it("imports a domain suggestion", async () => {
    const store = createInMemoryStore();

    await importLearnedDecisions(
      store,
      [
        {
          subjectId: keyFor("bad.example"),
          scope: "domain",
          label: "bad.example",
          reason: "filter",
          messageCount: 0,
          unreadShare: null,
        },
      ],
      NOW,
    );

    expect((await store.domains.get(keyFor("bad.example")))?.trustStatus).toBe("blocked");
  });
});
