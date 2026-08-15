// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { keyFor } from "../keys";
import {
  createInMemoryStore,
  domainBuilder,
  messageMetaBuilder,
  senderBuilder,
  MockGmailClient,
} from "../testing";
import { estimateWeeklyVolume, simulateEnforcement } from "./simulate";
import type { MessageMeta } from "../ports/GmailClient";

const msgFrom = (from: string): MessageMeta => messageMetaBuilder({ headers: { from } });

describe("estimateWeeklyVolume", () => {
  it("extrapolates weekly volume from the last-30-day count", () => {
    expect(estimateWeeklyVolume({ recencyBuckets: { d30: 30, d90: 0, d180: 0, older: 0 } })).toBe(
      7,
    );
    expect(estimateWeeklyVolume({ recencyBuckets: { d30: 0, d90: 9, d180: 0, older: 0 } })).toBe(0);
  });
});

describe("simulateEnforcement", () => {
  it("counts a new block: creates a filter and trashes existing mail, no mutation", async () => {
    const store = createInMemoryStore();
    const sender = senderBuilder("deals@retailco.test", { totalEmails: 5 });
    await store.senders.put(sender);
    const gmail = new MockGmailClient();

    const impact = await simulateEnforcement(gmail, store, [
      {
        subjectId: sender.id,
        scope: "address",
        decision: "block",
        actions: ["create_filter", "delete"],
      },
    ]);

    expect(impact.filtersToCreate).toBe(1);
    expect(impact.filtersToDelete).toBe(0);
    // listMessageIdsForSender is queried for the count; no filters/labels were mutated.
    expect(gmail.createdFilters).toHaveLength(0);
    expect(gmail.batchModifyCalls).toHaveLength(0);
    expect(gmail.senderQueries).toContain("deals@retailco.test");
  });

  it("a prospective whole-domain trust drops a blocked member from the preview (#144)", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("promo@shop.test", { trustStatus: "blocked" }));
    await store.domains.put(domainBuilder("shop.test")); // domain undecided (pending)
    const gmail = new MockGmailClient();

    // As-is, the standing block would compile a filter...
    const before = await simulateEnforcement(gmail, store, []);
    // ...but previewing a whole-domain trust makes the member effectively trusted → no filter.
    const after = await simulateEnforcement(gmail, store, [
      { subjectId: keyFor("shop.test"), scope: "domain", decision: "trust" },
    ]);

    expect(before.filtersToCreate).toBe(1);
    expect(after.filtersToCreate).toBe(0);
  });

  it("keeps a domain filter's exception carve-out in the preview, so it doesn't churn (#145)", async () => {
    const store = createInMemoryStore();
    await store.domains.put(
      domainBuilder("shop.test", {
        trustStatus: "blocked",
        decisionScope: "domain",
        exceptionAddresses: ["vip@shop.test"],
      }),
    );
    await store.senders.put(
      senderBuilder("vip@shop.test", { trustStatus: "trusted", decisionScope: "address" }),
    );
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      {
        id: "f1",
        from: "*@shop.test",
        excludeFrom: "vip@shop.test",
        addLabelIds: ["TRASH"],
        removeLabelIds: ["INBOX"],
      },
    ]);
    await store.filterSync.put({
      key: "filterSyncState",
      lastSyncAt: null,
      totalFilters: 1,
      managedFilterIds: ["f1"],
      enumeratedDomains: [],
    });

    const impact = await simulateEnforcement(gmail, store, []);

    // The previewed desired filter carries the same exclusion as the existing one → no churn.
    expect(impact.filtersToCreate).toBe(0);
    expect(impact.filtersToDelete).toBe(0);
  });

  it("reflects a batch address-trust as a new exception carve-out on a blocked domain (#161)", async () => {
    const store = createInMemoryStore();
    // shop.test is already blocked at domain scope, with NO stored exceptions yet.
    await store.domains.put(
      domainBuilder("shop.test", { trustStatus: "blocked", decisionScope: "domain" }),
    );
    await store.senders.put(senderBuilder("promo@shop.test", { trustStatus: "blocked" }));
    const gmail = new MockGmailClient();
    // The managed filter is the plain domain block, no carve-out.
    gmail.seedFilters([
      { id: "f1", from: "*@shop.test", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    await store.filterSync.put({
      key: "filterSyncState",
      lastSyncAt: null,
      totalFilters: 1,
      managedFilterIds: ["f1"],
      enumeratedDomains: [],
    });

    // Previewing "trust promo@shop.test" would (in the real apply) record it as a domain
    // exception, so the desired filter gains a negatedQuery carve-out and the plain one is
    // replaced — the preview must reflect that, not read the stored (empty) exception set.
    const impact = await simulateEnforcement(gmail, store, [
      { subjectId: keyFor("promo@shop.test"), scope: "address", decision: "trust" },
    ]);

    expect(impact.filtersToDelete).toBe(1); // the plain *@shop.test filter
    expect(impact.filtersToCreate).toBe(1); // replaced by *@shop.test carrying the carve-out
  });

  it("excludes a batch-trusted member from a same-batch domain block's message estimate (#161)", async () => {
    const store = createInMemoryStore();
    await store.domains.put(domainBuilder("shop.test")); // pending; blocked in the batch below
    await store.senders.put(senderBuilder("keep@shop.test", { trustStatus: "pending" }));
    const gmail = new MockGmailClient([msgFrom("promo@shop.test"), msgFrom("keep@shop.test")]);

    // "Block the domain but keep this sender" in one batch: the member becomes a domain
    // exception, so its existing mail is not swept. (The preview models this intended end
    // state; the real apply reaches it when the domain decision establishes domain scope.)
    const impact = await simulateEnforcement(gmail, store, [
      {
        subjectId: keyFor("shop.test"),
        scope: "domain",
        decision: "block",
        actions: ["create_filter", "delete"],
      },
      { subjectId: keyFor("keep@shop.test"), scope: "address", decision: "trust" },
    ]);

    expect(impact.messagesToDelete).toBe(1); // only promo@shop.test; keep@shop.test is carved out
  });

  it("does not count a separately-trusted subdomain's mail in a domain block (#210)", async () => {
    const store = createInMemoryStore();
    await store.domains.put(domainBuilder("mybank.test")); // pending; blocked in the batch below
    await store.domains.put(
      domainBuilder("email.mybank.test", { trustStatus: "trusted", decisionScope: "domain" }),
    );
    await store.domains.put(domainBuilder("ads.mybank.test", { trustStatus: "pending" }));
    const gmail = new MockGmailClient([
      msgFrom("promo@mybank.test"),
      msgFrom("statements@email.mybank.test"),
      msgFrom("offers@ads.mybank.test"),
    ]);

    const impact = await simulateEnforcement(gmail, store, [
      {
        subjectId: keyFor("mybank.test"),
        scope: "domain",
        decision: "block",
        actions: ["create_filter", "delete"],
      },
    ]);

    // The block spans the subtree, so the undecided subdomain counts — but the trusted one is
    // carved out, and the preview must not promise to delete mail the apply will spare.
    expect(impact.messagesToDelete).toBe(2);
  });

  it("counts an undecided subdomain's mail, since the block does cover it (#210)", async () => {
    const store = createInMemoryStore();
    await store.domains.put(domainBuilder("mybank.test"));
    await store.domains.put(domainBuilder("ads.mybank.test", { trustStatus: "pending" }));
    const gmail = new MockGmailClient([
      msgFrom("promo@mybank.test"),
      msgFrom("offers@ads.mybank.test"),
    ]);

    const impact = await simulateEnforcement(gmail, store, [
      {
        subjectId: keyFor("mybank.test"),
        scope: "domain",
        decision: "block",
        actions: ["create_filter", "delete"],
      },
    ]);

    // The number was already right before #210 — what was missing was saying WHY it was this
    // big. Asserted here so the breadth cannot be narrowed back without a deliberate choice.
    expect(impact.messagesToDelete).toBe(2);
  });

  it("spares a trusted sender at an undecided subdomain of the blocked domain (#244)", async () => {
    const store = createInMemoryStore();
    await store.domains.put(
      domainBuilder("example.com", { trustStatus: "blocked", decisionScope: "domain" }),
    );
    // Undecided, so the block covers it — all but the one address decided below.
    await store.domains.put(domainBuilder("email.example.com", { trustStatus: "pending" }));
    await store.senders.put(senderBuilder("statements@email.example.com"));
    await store.senders.put(senderBuilder("offers@email.example.com"));
    const gmail = new MockGmailClient([
      msgFrom("promo@example.com"),
      msgFrom("statements@email.example.com"),
      msgFrom("offers@email.example.com"),
    ]);

    // Blocked already, and the trust previewed on top — the ordering the preview has to model,
    // since the exception this would record lands on the block covering the subtree, not on
    // the sender's own (undecided) subdomain record.
    const impact = await simulateEnforcement(gmail, store, [
      {
        subjectId: keyFor("statements@email.example.com"),
        scope: "address",
        decision: "trust",
      },
      {
        subjectId: keyFor("example.com"),
        scope: "domain",
        decision: "block",
        actions: ["create_filter", "delete"],
      },
    ]);

    // The apex and the subdomain's undecided sender; NOT the one being trusted in the same batch.
    expect(impact.messagesToDelete).toBe(2);
  });

  it("classifies archive vs delete from the staged actions", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("a@x.test"));
    await store.senders.put(senderBuilder("b@y.test"));
    const gmail = new MockGmailClient();
    // Two messages each so the count is observable.
    gmail.seedInbox([
      {
        id: "1",
        threadId: "t1",
        labelIds: ["INBOX"],
        internalDate: 0,
        headers: { from: "a@x.test" },
      },
      {
        id: "2",
        threadId: "t2",
        labelIds: ["INBOX"],
        internalDate: 0,
        headers: { from: "a@x.test" },
      },
      {
        id: "3",
        threadId: "t3",
        labelIds: ["INBOX"],
        internalDate: 0,
        headers: { from: "b@y.test" },
      },
    ]);

    const impact = await simulateEnforcement(gmail, store, [
      { subjectId: keyFor("a@x.test"), scope: "address", decision: "block", actions: ["archive"] },
      { subjectId: keyFor("b@y.test"), scope: "address", decision: "block", actions: ["delete"] },
    ]);

    expect(impact.messagesToArchive).toBe(2);
    expect(impact.messagesToDelete).toBe(1);
  });

  it("counts filters removed when reversing a block to trust", async () => {
    const store = createInMemoryStore();
    // A currently-blocked sender whose filter exists in Gmail.
    await store.senders.put(senderBuilder("spam@x.test", { trustStatus: "blocked" }));
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      { id: "f1", from: "spam@x.test", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    // The filter was created by this app in an earlier run, so it's tracked as managed.
    await store.filterSync.put({
      key: "filterSyncState",
      lastSyncAt: null,
      totalFilters: 1,
      managedFilterIds: ["f1"],
      enumeratedDomains: [],
    });

    const impact = await simulateEnforcement(gmail, store, [
      { subjectId: keyFor("spam@x.test"), scope: "address", decision: "trust" },
    ]);

    expect(impact.filtersToDelete).toBe(1);
    expect(impact.filtersToCreate).toBe(0);
    expect(gmail.deletedFilterIds).toHaveLength(0); // no mutation
  });

  it("treats a defer on an already-decided sender as a no-op, not a reversal (#148)", async () => {
    const store = createInMemoryStore();
    // A currently-blocked sender whose managed filter exists in Gmail.
    await store.senders.put(senderBuilder("spam@x.test", { trustStatus: "blocked" }));
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      { id: "f1", from: "spam@x.test", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    await store.filterSync.put({
      key: "filterSyncState",
      lastSyncAt: null,
      totalFilters: 1,
      managedFilterIds: ["f1"],
      enumeratedDomains: [],
    });

    // Previewing "not sure" (defer) must leave the block intact — the real apply is a no-op,
    // so the preview must not show the filter being removed.
    const impact = await simulateEnforcement(gmail, store, [
      { subjectId: keyFor("spam@x.test"), scope: "address", decision: "defer" },
    ]);

    expect(impact.filtersToDelete).toBe(0);
    expect(impact.filtersToCreate).toBe(0);
  });

  it("treats a defer on an already-blocked domain as a no-op (#148)", async () => {
    const store = createInMemoryStore();
    // A currently-blocked domain whose managed wildcard filter exists in Gmail.
    await store.domains.put(domainBuilder("promo.test", { trustStatus: "blocked" }));
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      { id: "d1", from: "*@promo.test", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    await store.filterSync.put({
      key: "filterSyncState",
      lastSyncAt: null,
      totalFilters: 1,
      managedFilterIds: ["d1"],
      enumeratedDomains: [],
    });

    const impact = await simulateEnforcement(gmail, store, [
      { subjectId: keyFor("promo.test"), scope: "domain", decision: "defer" },
    ]);

    expect(impact.filtersToDelete).toBe(0);
    expect(impact.filtersToCreate).toBe(0);
  });

  it("previews a defer on a still-pending sender as no change (#148)", async () => {
    const store = createInMemoryStore();
    // Pending, no filter anywhere — a defer keeps it pending, so nothing is created or removed.
    await store.senders.put(senderBuilder("maybe@x.test", { trustStatus: "pending" }));
    const gmail = new MockGmailClient();

    const impact = await simulateEnforcement(gmail, store, [
      { subjectId: keyFor("maybe@x.test"), scope: "address", decision: "defer" },
    ]);

    expect(impact).toEqual({
      filtersToCreate: 0,
      filtersToDelete: 0,
      messagesToArchive: 0,
      messagesToDelete: 0,
      messagesToRescue: 0,
    });
  });

  it("never previews deleting a foreign filter sharing the block action shape (#29)", async () => {
    const store = createInMemoryStore();
    const gmail = new MockGmailClient();
    // Hand-built by the user in Gmail's own UI — no managed-filter record for it.
    gmail.seedFilters([
      {
        id: "hand-made",
        from: "oldjob@company.test",
        addLabelIds: ["TRASH"],
        removeLabelIds: ["INBOX"],
      },
    ]);

    const impact = await simulateEnforcement(gmail, store, []);

    expect(impact.filtersToDelete).toBe(0);
  });

  it("counts spam-marked mail that a trust reversal would rescue", async () => {
    const store = createInMemoryStore();
    await store.senders.put(
      senderBuilder("news@x.test", { trustStatus: "blocked", spamMarkedCount: 4 }),
    );
    const gmail = new MockGmailClient();

    const impact = await simulateEnforcement(gmail, store, [
      { subjectId: keyFor("news@x.test"), scope: "address", decision: "trust" },
    ]);

    expect(impact.messagesToRescue).toBe(4);
  });

  it("counts every member a whole-domain trust would rescue (#192)", async () => {
    const store = createInMemoryStore();
    await store.domains.put(domainBuilder("news.test"));
    await store.senders.put(
      senderBuilder("daily@news.test", { trustStatus: "blocked", spamMarkedCount: 3 }),
    );
    await store.senders.put(
      senderBuilder("weekly@news.test", { trustStatus: "pending", spamMarkedCount: 2 }),
    );
    // A different domain's spam-marked mail is untouched by this decision.
    await store.senders.put(
      senderBuilder("promo@shop.test", { trustStatus: "blocked", spamMarkedCount: 9 }),
    );
    const gmail = new MockGmailClient();

    const impact = await simulateEnforcement(gmail, store, [
      { subjectId: keyFor("news.test"), scope: "domain", decision: "trust" },
    ]);

    // Both members become effectively trusted, so enforce would rescue 3 + 2 — the preview
    // used to report none of it.
    expect(impact.messagesToRescue).toBe(5);
  });

  it("does not rescue a member the same batch blocks as an exception (#192)", async () => {
    const store = createInMemoryStore();
    await store.domains.put(domainBuilder("news.test"));
    await store.senders.put(
      senderBuilder("daily@news.test", { trustStatus: "pending", spamMarkedCount: 3 }),
    );
    await store.senders.put(
      senderBuilder("junk@news.test", { trustStatus: "pending", spamMarkedCount: 7 }),
    );
    const gmail = new MockGmailClient();

    // "Trust the domain, except this one sender": the address block is recorded as a domain
    // exception, so its mail stays where it is.
    const impact = await simulateEnforcement(gmail, store, [
      { subjectId: keyFor("news.test"), scope: "domain", decision: "trust" },
      {
        subjectId: keyFor("junk@news.test"),
        scope: "address",
        decision: "block",
        actions: ["create_filter"],
      },
    ]);

    expect(impact.messagesToRescue).toBe(3);
  });

  it("counts a sender covered by both an address and a domain trust once (#192)", async () => {
    const store = createInMemoryStore();
    await store.domains.put(domainBuilder("news.test"));
    await store.senders.put(
      senderBuilder("daily@news.test", { trustStatus: "blocked", spamMarkedCount: 4 }),
    );
    const gmail = new MockGmailClient();

    const impact = await simulateEnforcement(gmail, store, [
      { subjectId: keyFor("news.test"), scope: "domain", decision: "trust" },
      { subjectId: keyFor("daily@news.test"), scope: "address", decision: "trust" },
    ]);

    expect(impact.messagesToRescue).toBe(4);
  });

  it("excludes a domain's trusted exception from the block's message estimate (#151)", async () => {
    const store = createInMemoryStore();
    // A blocked domain with one trusted exception address carved out.
    await store.domains.put(
      domainBuilder("shop.test", {
        trustStatus: "blocked",
        decisionScope: "domain",
        exceptionAddresses: ["vip@shop.test"],
      }),
    );
    await store.senders.put(
      senderBuilder("vip@shop.test", { trustStatus: "trusted", decisionScope: "address" }),
    );
    // Two messages from an ordinary domain member + one from the trusted exception.
    const gmail = new MockGmailClient([
      msgFrom("promo@shop.test"),
      msgFrom("promo@shop.test"),
      msgFrom("vip@shop.test"),
    ]);

    const impact = await simulateEnforcement(gmail, store, [
      {
        subjectId: keyFor("shop.test"),
        scope: "domain",
        decision: "block",
        actions: ["create_filter", "delete"],
      },
    ]);

    // The exception's message is not counted — only the two non-exception messages, matching
    // what enforce's exception-excluding sweep would actually trash.
    expect(impact.messagesToDelete).toBe(2);
  });

  it("previews a whole-domain block", async () => {
    const store = createInMemoryStore();
    await store.domains.put(domainBuilder("promo.test"));
    const gmail = new MockGmailClient();

    const impact = await simulateEnforcement(gmail, store, [
      {
        subjectId: keyFor("promo.test"),
        scope: "domain",
        decision: "block",
        actions: ["create_filter", "archive"],
      },
    ]);

    expect(impact.filtersToCreate).toBe(1);
    expect(gmail.senderQueries).toContain("*@promo.test");
  });
});

describe("simulateEnforcement — parent-domain rules (#218)", () => {
  it("counts the rescue when a parent-domain trust covers a blocked subtree member", async () => {
    const store = createInMemoryStore();
    await store.domains.put(domainBuilder("example.com"));
    await store.domains.put(
      domainBuilder("news.example.com", { trustStatus: "blocked", decisionScope: "domain" }),
    );
    await store.senders.put(
      senderBuilder("promo@news.example.com", { trustStatus: "blocked", spamMarkedCount: 6 }),
    );
    const gmail = new MockGmailClient();

    // A parent-scope TRUST — the path that resolves members through the ladder. An
    // address-scope trust would credit the rescue unconditionally and prove nothing.
    const impact = await simulateEnforcement(gmail, store, [
      { subjectId: keyFor("example.com"), scope: "parentDomain", decision: "trust" },
    ]);

    // The member lives at a SUBdomain, so an exact-name member lookup finds nobody, and a
    // resolver blind to the parent rule leaves it blocked. Either way the rescue reads 0.
    expect(impact.messagesToRescue).toBe(6);
  });

  it("previews a parent block as covering the subtree's senders", async () => {
    const store = createInMemoryStore();
    await store.domains.put(domainBuilder("example.com"));
    await store.senders.put(senderBuilder("promo@news.example.com", { trustStatus: "pending" }));
    const gmail = new MockGmailClient();

    const impact = await simulateEnforcement(gmail, store, [
      { subjectId: keyFor("example.com"), scope: "parentDomain", decision: "block" },
    ]);

    expect(impact.filtersToCreate).toBeGreaterThan(0);
  });

  it("counts the existing mail a parent block would sweep", async () => {
    const store = createInMemoryStore();
    await store.domains.put(domainBuilder("example.com"));
    await store.senders.put(senderBuilder("promo@news.example.com", { trustStatus: "pending" }));
    // Apex senders: the in-memory client matches `*@domain` on the exact domain, which is
    // what the app believed before #210 measured Gmail actually spanning subdomains. Testing
    // the sweep's breadth here would assert the mock's belief, not Gmail's behaviour — that
    // belongs with #210's fix, which has to update the mock too.
    const gmail = new MockGmailClient([msgFrom("one@example.com"), msgFrom("two@example.com")]);

    const impact = await simulateEnforcement(gmail, store, [
      {
        subjectId: keyFor("example.com"),
        scope: "parentDomain",
        decision: "block",
        actions: ["create_filter", "delete"],
      },
    ]);

    // enforce sweeps a blocked domain record as `*@domain` whatever its scope, so a preview
    // that resolved the subject only for `scope === "domain"` reported nothing swept at all.
    expect(impact.messagesToDelete).toBe(2);
  });

  it("keeps a sender the same batch carves out of a parent block", async () => {
    const store = createInMemoryStore();
    await store.domains.put(domainBuilder("example.com"));
    await store.senders.put(senderBuilder("vip@example.com", { trustStatus: "pending" }));
    await store.senders.put(senderBuilder("promo@example.com", { trustStatus: "pending" }));
    const gmail = new MockGmailClient([msgFrom("vip@example.com"), msgFrom("promo@example.com")]);

    // "Block the whole subtree, but keep this one": applyDecision records the address as an
    // exception on the parent, so its mail must be excluded from the sweep — kept, not swept.
    const impact = await simulateEnforcement(gmail, store, [
      {
        subjectId: keyFor("example.com"),
        scope: "parentDomain",
        decision: "block",
        actions: ["delete"],
      },
      { subjectId: keyFor("vip@example.com"), scope: "address", decision: "trust" },
    ]);

    expect(impact.messagesToDelete).toBe(1);
  });

  it("keeps an apex sender's block filter uncreated when its own record's parentDomain rule trusts it (#222)", async () => {
    const store = createInMemoryStore();
    // example.com IS its own registrable domain, so the subtree trust lives on this record at
    // "parentDomain" scope rather than "domain" — the real scope `prospectiveStatusOf` must read
    // rather than assume, so the preview agrees with enforcement by construction.
    await store.domains.put(
      domainBuilder("example.com", { trustStatus: "trusted", decisionScope: "parentDomain" }),
    );
    // Blocked individually before the domain-wide trust, and never recorded as an exception.
    await store.senders.put(senderBuilder("ceo@example.com", { trustStatus: "blocked" }));
    const gmail = new MockGmailClient();

    const impact = await simulateEnforcement(gmail, store, []);

    expect(impact.filtersToCreate).toBe(0);
  });
});
