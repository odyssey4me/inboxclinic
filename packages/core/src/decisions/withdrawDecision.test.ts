// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { applyDecision } from "./applyDecision";
import { keyFor } from "../keys";
import { createInMemoryStore, domainBuilder, senderBuilder } from "../testing";
import { withdrawDecision } from "./withdrawDecision";

const NOW = 1_700_000_000_000;

describe("withdrawDecision", () => {
  it("returns a sender to being governed by its domain's rule", async () => {
    const store = createInMemoryStore();
    await store.domains.put(
      domainBuilder("shop.test", { trustStatus: "blocked", decisionScope: "domain" }),
    );
    await store.senders.put(senderBuilder("vip@shop.test"));
    // Trusting under a domain block records the carve-out that makes the exception real.
    await applyDecision(store, {
      subjectId: keyFor("vip@shop.test"),
      scope: "address",
      decision: "trust",
      now: NOW,
    });

    const result = await withdrawDecision(store, {
      subjectId: keyFor("vip@shop.test"),
      scope: "address",
    });

    // Both halves: the decision is gone AND the carve-out with it, or the rule would still
    // be told to skip a sender that no longer claims an exemption.
    expect(result.withdrawn).toBe(true);
    expect(result.status).toBe("blocked");
    expect(result.clearedExceptionsOn).toEqual(["shop.test"]);
    const sender = await store.senders.get(keyFor("vip@shop.test"));
    expect(sender?.trustStatus).toBe("pending");
    expect(sender?.decisionScope).toBeNull();
    const domain = await store.domains.get(keyFor("shop.test"));
    expect(domain?.exceptionAddresses).toEqual([]);
  });

  it("clears staged block actions along with the decision", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("spam@x.test"));
    await applyDecision(store, {
      subjectId: keyFor("spam@x.test"),
      scope: "address",
      decision: "block",
      actions: ["create_filter", "delete"],
      now: NOW,
    });

    await withdrawDecision(store, { subjectId: keyFor("spam@x.test"), scope: "address" });

    // Left in place, the next enforce would carry out a block the user just stepped back from.
    expect((await store.senders.get(keyFor("spam@x.test")))?.pendingActions).toEqual([]);
  });

  it("returns a subdomain to being governed by the parent rule it was carved out of", async () => {
    const store = createInMemoryStore();
    await store.domains.put(
      domainBuilder("example.com", { trustStatus: "blocked", decisionScope: "parentDomain" }),
    );
    await store.domains.put(domainBuilder("news.example.com"));
    await applyDecision(store, {
      subjectId: keyFor("news.example.com"),
      scope: "domain",
      decision: "trust",
      now: NOW,
    });

    const result = await withdrawDecision(store, {
      subjectId: keyFor("news.example.com"),
      scope: "domain",
    });

    expect(result.status).toBe("blocked");
    expect(result.clearedExceptionsOn).toEqual(["example.com"]);
    const parent = await store.domains.get(keyFor("example.com"));
    expect(parent?.exceptionDomains).toEqual([]);
  });

  it("leaves the broader rule itself untouched", async () => {
    const store = createInMemoryStore();
    await store.domains.put(
      domainBuilder("example.com", { trustStatus: "blocked", decisionScope: "parentDomain" }),
    );
    await store.domains.put(domainBuilder("news.example.com"));
    await applyDecision(store, {
      subjectId: keyFor("news.example.com"),
      scope: "domain",
      decision: "trust",
      now: NOW,
    });

    await withdrawDecision(store, { subjectId: keyFor("news.example.com"), scope: "domain" });

    // Withdrawing is about one subject rejoining a rule — never about weakening the rule.
    const parent = await store.domains.get(keyFor("example.com"));
    expect(parent?.trustStatus).toBe("blocked");
    expect(parent?.decisionScope).toBe("parentDomain");
  });

  it("leaves a subject genuinely undecided when nothing covers it", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("solo@x.test"));
    await applyDecision(store, {
      subjectId: keyFor("solo@x.test"),
      scope: "address",
      decision: "block",
      now: NOW,
    });

    const result = await withdrawDecision(store, {
      subjectId: keyFor("solo@x.test"),
      scope: "address",
    });

    // Nothing above it, so it really is undecided again — and the next scan's
    // `generatePrompts` picks it up, which is why nothing is prompted from here.
    expect(result.status).toBe("pending");
    expect(result.clearedExceptionsOn).toEqual([]);
  });

  it("is a no-op on a subject that was never decided", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("never@x.test"));

    const result = await withdrawDecision(store, {
      subjectId: keyFor("never@x.test"),
      scope: "address",
    });

    // "Stop deciding this" is already true of it — not an error.
    expect(result.withdrawn).toBe(false);
    expect(result.status).toBe("pending");
  });

  it("clears a carve-out on BOTH the exact domain and the parent rule", async () => {
    const store = createInMemoryStore();
    await store.domains.put(
      domainBuilder("example.com", { trustStatus: "blocked", decisionScope: "parentDomain" }),
    );
    await store.domains.put(
      domainBuilder("news.example.com", { trustStatus: "blocked", decisionScope: "domain" }),
    );
    await store.senders.put(senderBuilder("vip@news.example.com"));
    // Recorded on both rules covering it, per applyDecision's broaderRulesFor.
    await applyDecision(store, {
      subjectId: keyFor("vip@news.example.com"),
      scope: "address",
      decision: "trust",
      now: NOW,
    });

    const result = await withdrawDecision(store, {
      subjectId: keyFor("vip@news.example.com"),
      scope: "address",
    });

    // Missing either one leaves a carve-out for a decision that no longer exists.
    expect(result.clearedExceptionsOn.sort()).toEqual(["example.com", "news.example.com"]);
    expect((await store.domains.get(keyFor("news.example.com")))?.exceptionAddresses).toEqual([]);
    expect((await store.domains.get(keyFor("example.com")))?.exceptionAddresses).toEqual([]);
  });

  it("clears a carve-out held by a domain block covering the subtree (#244)", async () => {
    const store = createInMemoryStore();
    await store.domains.put(
      domainBuilder("example.com", { trustStatus: "blocked", decisionScope: "domain" }),
    );
    // Undecided, so the carve-out lives only on the block above it — nowhere else to look.
    await store.domains.put(domainBuilder("email.example.com", { trustStatus: "pending" }));
    await store.senders.put(senderBuilder("statements@email.example.com"));
    await applyDecision(store, {
      subjectId: keyFor("statements@email.example.com"),
      scope: "address",
      decision: "trust",
      now: NOW,
    });

    const result = await withdrawDecision(store, {
      subjectId: keyFor("statements@email.example.com"),
      scope: "address",
    });

    // The sender falls back under the block it was carved out of, and the carve-out goes with
    // the decision — leaving it would spare a sender that no longer has a decision to spare.
    expect(result.clearedExceptionsOn).toEqual(["example.com"]);
    expect((await store.domains.get(keyFor("example.com")))?.exceptionAddresses).toEqual([]);
    expect(result.status).toBe("blocked");
  });

  it("throws for a subject that does not exist", async () => {
    const store = createInMemoryStore();
    await expect(
      withdrawDecision(store, { subjectId: keyFor("ghost@x.test"), scope: "address" }),
    ).rejects.toThrow(/no sender/);
  });
});
