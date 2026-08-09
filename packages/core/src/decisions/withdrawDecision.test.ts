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
      domainBuilder("shop.com", { trustStatus: "blocked", decisionScope: "domain" }),
    );
    await store.senders.put(senderBuilder("vip@shop.com"));
    // Trusting under a domain block records the carve-out that makes the exception real.
    await applyDecision(store, {
      subjectId: keyFor("vip@shop.com"),
      scope: "address",
      decision: "trust",
      now: NOW,
    });

    const result = await withdrawDecision(store, {
      subjectId: keyFor("vip@shop.com"),
      scope: "address",
    });

    // Both halves: the decision is gone AND the carve-out with it, or the rule would still
    // be told to skip a sender that no longer claims an exemption.
    expect(result.withdrawn).toBe(true);
    expect(result.status).toBe("blocked");
    expect(result.clearedExceptionsOn).toEqual(["shop.com"]);
    const sender = await store.senders.get(keyFor("vip@shop.com"));
    expect(sender?.trustStatus).toBe("pending");
    expect(sender?.decisionScope).toBeNull();
    const domain = await store.domains.get(keyFor("shop.com"));
    expect(domain?.exceptionAddresses).toEqual([]);
  });

  it("clears staged block actions along with the decision", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("spam@x.com"));
    await applyDecision(store, {
      subjectId: keyFor("spam@x.com"),
      scope: "address",
      decision: "block",
      actions: ["create_filter", "delete"],
      now: NOW,
    });

    await withdrawDecision(store, { subjectId: keyFor("spam@x.com"), scope: "address" });

    // Left in place, the next enforce would carry out a block the user just stepped back from.
    expect((await store.senders.get(keyFor("spam@x.com")))?.pendingActions).toEqual([]);
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
    await store.senders.put(senderBuilder("solo@x.com"));
    await applyDecision(store, {
      subjectId: keyFor("solo@x.com"),
      scope: "address",
      decision: "block",
      now: NOW,
    });

    const result = await withdrawDecision(store, {
      subjectId: keyFor("solo@x.com"),
      scope: "address",
    });

    // Nothing above it, so it really is undecided again — and the next scan's
    // `generatePrompts` picks it up, which is why nothing is prompted from here.
    expect(result.status).toBe("pending");
    expect(result.clearedExceptionsOn).toEqual([]);
  });

  it("is a no-op on a subject that was never decided", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("never@x.com"));

    const result = await withdrawDecision(store, {
      subjectId: keyFor("never@x.com"),
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

  it("throws for a subject that does not exist", async () => {
    const store = createInMemoryStore();
    await expect(
      withdrawDecision(store, { subjectId: keyFor("ghost@x.com"), scope: "address" }),
    ).rejects.toThrow(/no sender/);
  });
});
