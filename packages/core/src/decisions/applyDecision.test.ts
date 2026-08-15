// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { keyFor } from "../keys";
import { createInMemoryStore } from "../testing";
import type { BlockAction, Domain, Prompt, Sender, Store } from "../store";
import { applyDecision, applyDecisions, DEFER_DECAY } from "./applyDecision";
import { resolveEffectiveDecision } from "./resolveEffectiveDecision";

const NOW = 1_700_000_000_000;

function senderFix(email: string, overrides: Partial<Sender> = {}): Sender {
  return {
    id: keyFor(email),
    email,
    domain: email.slice(email.indexOf("@") + 1),
    displayName: null,
    category: "personal",
    trustStatus: "pending",
    totalEmails: 5,
    hasListUnsubscribe: false,
    hasListId: false,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    updatedAt: NOW,
    readRate: 0.5,
    starredCount: 0,
    spamMarkedCount: 0,
    deletedUnreadCount: 0,
    coveredByBlockFilter: false,
    replyCount: 0,
    inContacts: false,
    frequency: "weekly",
    recencyBuckets: { d30: 5, d90: 0, d180: 0, older: 0 },
    auth: { spf: false, dkim: false, dmarc: false, spoofed: false },
    trustDecidedAt: null,
    decisionScope: null,
    decisionContext: null,
    pendingActions: [],
    ...overrides,
  };
}

function domainFix(domain: string, overrides: Partial<Domain> = {}): Domain {
  return {
    id: keyFor(domain),
    domain,
    trustStatus: "pending",
    senderCount: 1,
    totalEmails: 5,
    exceptionAddresses: [],
    exceptionDomains: [],
    updatedAt: NOW,
    trustDecidedAt: null,
    decisionScope: null,
    decisionContext: null,
    pendingActions: [],
    ...overrides,
  };
}

function promptFix(email: string): Prompt {
  return {
    id: keyFor(email),
    senderId: keyFor(email),
    priorityScore: 50,
    components: { impact: 0, confidence: 0, batch: 0, alignment: 0 },
    batchGroupId: null,
    batchSize: 1,
    createdAt: NOW,
    expiresAt: NOW + 1,
    resolvedAt: null,
    deferredAt: null,
  };
}

/** A store seeded with two acme.test senders + one other.test sender, all with prompts. */
async function seed(): Promise<Store> {
  const store = createInMemoryStore();
  await store.senders.bulkPut([
    senderFix("a@acme.test"),
    senderFix("b@acme.test"),
    senderFix("solo@other.test", { hasListUnsubscribe: true, category: "promotional" }),
  ]);
  await store.domains.bulkPut([
    domainFix("acme.test", { senderCount: 2, totalEmails: 10 }),
    domainFix("other.test"),
  ]);
  await store.prompts.bulkPut([
    promptFix("a@acme.test"),
    promptFix("b@acme.test"),
    promptFix("solo@other.test"),
  ]);
  return store;
}

describe("applyDecision — address scope", () => {
  it("records a Trust decision and resolves the prompt", async () => {
    const store = await seed();
    const result = await applyDecision(store, {
      subjectId: keyFor("a@acme.test"),
      scope: "address",
      decision: "trust",
      now: NOW,
    });

    expect(result.status).toBe("trusted");
    expect(result.resolvedPromptIds).toEqual([keyFor("a@acme.test")]);

    const sender = await store.senders.get(keyFor("a@acme.test"));
    expect(sender).toMatchObject({
      trustStatus: "trusted",
      trustDecidedAt: NOW,
      decisionScope: "address",
    });
    expect(sender?.decisionContext).toMatchObject({ decidedVia: "workflow", category: "personal" });
    expect((await store.prompts.get(keyFor("a@acme.test")))?.resolvedAt).toBe(NOW);
  });

  it("stores Block actions as pending without touching Gmail", async () => {
    const store = await seed();
    const result = await applyDecision(store, {
      subjectId: keyFor("solo@other.test"),
      scope: "address",
      decision: "block",
      actions: ["unsubscribe", "create_filter"],
      decidedVia: "dashboard",
      now: NOW,
    });

    expect(result.status).toBe("blocked");
    expect(result.pendingActions).toEqual(["unsubscribe", "create_filter"]);

    const sender = await store.senders.get(keyFor("solo@other.test"));
    expect(sender?.trustStatus).toBe("blocked");
    expect(sender?.pendingActions).toEqual(["unsubscribe", "create_filter"]);
    expect(sender?.decisionContext?.decidedVia).toBe("dashboard");
    expect((await store.prompts.get(keyFor("solo@other.test")))?.resolvedAt).toBe(NOW);
  });

  it("defers: decays priority, marks deferredAt, leaves the prompt unresolved", async () => {
    const store = await seed();
    const before = await store.prompts.get(keyFor("a@acme.test"));

    const result = await applyDecision(store, {
      subjectId: keyFor("a@acme.test"),
      scope: "address",
      decision: "defer",
      now: NOW,
    });

    expect(result.status).toBe("pending");
    expect(result.deferredPromptIds).toEqual([keyFor("a@acme.test")]);

    const after = await store.prompts.get(keyFor("a@acme.test"));
    expect(after?.resolvedAt).toBeNull();
    expect(after?.deferredAt).toBe(NOW);
    expect(after?.priorityScore).toBeCloseTo(before!.priorityScore * DEFER_DECAY, 5);
    expect((await store.senders.get(keyFor("a@acme.test")))?.trustStatus).toBe("pending");
  });

  it("defer on an already-blocked sender is a no-op — status and pendingActions untouched", async () => {
    const store = await seed();
    await applyDecision(store, {
      subjectId: keyFor("a@acme.test"),
      scope: "address",
      decision: "block",
      actions: ["create_filter"],
      now: NOW,
    });

    const result = await applyDecision(store, {
      subjectId: keyFor("a@acme.test"),
      scope: "address",
      decision: "defer",
      now: NOW + 1,
    });

    expect(result.status).toBe("blocked");
    expect(result.pendingActions).toEqual(["create_filter"]);

    const sender = await store.senders.get(keyFor("a@acme.test"));
    expect(sender).toMatchObject({
      trustStatus: "blocked",
      trustDecidedAt: NOW,
      pendingActions: ["create_filter"],
    });
  });

  it("defer on an already-trusted sender is a no-op — status untouched", async () => {
    const store = await seed();
    await applyDecision(store, {
      subjectId: keyFor("a@acme.test"),
      scope: "address",
      decision: "trust",
      now: NOW,
    });

    const result = await applyDecision(store, {
      subjectId: keyFor("a@acme.test"),
      scope: "address",
      decision: "defer",
      now: NOW + 1,
    });

    expect(result.status).toBe("trusted");
    const sender = await store.senders.get(keyFor("a@acme.test"));
    expect(sender).toMatchObject({ trustStatus: "trusted", trustDecidedAt: NOW });
  });

  it("throws for an unknown sender", async () => {
    const store = await seed();
    await expect(
      applyDecision(store, {
        subjectId: keyFor("ghost@nowhere.test"),
        scope: "address",
        decision: "trust",
        now: NOW,
      }),
    ).rejects.toThrow(/no sender/);
  });
});

describe("applyDecision — domain scope (overrides address)", () => {
  it("records a domain decision and resolves every member prompt", async () => {
    const store = await seed();
    const result = await applyDecision(store, {
      subjectId: keyFor("acme.test"),
      scope: "domain",
      decision: "block",
      actions: ["create_filter"],
      now: NOW,
    });

    expect(result.status).toBe("blocked");
    expect(result.resolvedPromptIds.sort()).toEqual(
      [keyFor("a@acme.test"), keyFor("b@acme.test")].sort(),
    );

    const domain = await store.domains.get(keyFor("acme.test"));
    expect(domain).toMatchObject({ trustStatus: "blocked", decisionScope: "domain" });
    expect(domain?.pendingActions).toEqual(["create_filter"]);
    expect((await store.prompts.get(keyFor("a@acme.test")))?.resolvedAt).toBe(NOW);
    expect((await store.prompts.get(keyFor("b@acme.test")))?.resolvedAt).toBe(NOW);
    // A sender in a different domain is untouched.
    expect((await store.prompts.get(keyFor("solo@other.test")))?.resolvedAt).toBeNull();
  });

  it("skips address exceptions when resolving member prompts", async () => {
    const store = createInMemoryStore();
    await store.senders.bulkPut([senderFix("a@acme.test"), senderFix("b@acme.test")]);
    await store.domains.put(domainFix("acme.test", { exceptionAddresses: ["a@acme.test"] }));
    await store.prompts.bulkPut([promptFix("a@acme.test"), promptFix("b@acme.test")]);

    const result = await applyDecision(store, {
      subjectId: keyFor("acme.test"),
      scope: "domain",
      decision: "block",
      now: NOW,
    });

    expect(result.resolvedPromptIds).toEqual([keyFor("b@acme.test")]);
    expect((await store.prompts.get(keyFor("a@acme.test")))?.resolvedAt).toBeNull();
  });

  it("records an address decision under a domain decision as an explicit exception", async () => {
    const store = await seed();
    await applyDecision(store, {
      subjectId: keyFor("acme.test"),
      scope: "domain",
      decision: "trust",
      now: NOW,
    });
    await applyDecision(store, {
      subjectId: keyFor("a@acme.test"),
      scope: "address",
      decision: "block",
      now: NOW,
    });

    const domain = await store.domains.get(keyFor("acme.test"));
    expect(domain?.exceptionAddresses).toContain("a@acme.test");

    const sender = await store.senders.get(keyFor("a@acme.test"));
    const effective = resolveEffectiveDecision({
      addressStatus: sender!.trustStatus,
      addressIsException: domain!.exceptionAddresses.includes(sender!.email),
      domainStatus: domain!.trustStatus,
      domainScope: domain!.decisionScope,
    });
    expect(effective).toEqual({ status: "blocked", source: "address" });
  });

  it("does not record a defer as a domain exception (#195)", async () => {
    const store = await seed();
    await applyDecision(store, {
      subjectId: keyFor("acme.test"),
      scope: "domain",
      decision: "trust",
      now: NOW,
    });

    // "Not sure" leaves the sender undecided, so it carves nothing out of the domain's rule.
    await applyDecision(store, {
      subjectId: keyFor("a@acme.test"),
      scope: "address",
      decision: "defer",
      now: NOW,
    });

    const domain = await store.domains.get(keyFor("acme.test"));
    expect(domain?.exceptionAddresses).toEqual([]);
  });

  it("defers a whole domain, decaying every member prompt", async () => {
    const store = await seed();
    const result = await applyDecision(store, {
      subjectId: keyFor("acme.test"),
      scope: "domain",
      decision: "defer",
      now: NOW,
    });

    expect(result.status).toBe("pending");
    expect(result.deferredPromptIds.sort()).toEqual(
      [keyFor("a@acme.test"), keyFor("b@acme.test")].sort(),
    );
    expect((await store.prompts.get(keyFor("a@acme.test")))?.deferredAt).toBe(NOW);
  });

  it("defer on an already-blocked domain is a no-op — status and pendingActions untouched", async () => {
    const store = await seed();
    await applyDecision(store, {
      subjectId: keyFor("acme.test"),
      scope: "domain",
      decision: "block",
      actions: ["create_filter"],
      now: NOW,
    });

    const result = await applyDecision(store, {
      subjectId: keyFor("acme.test"),
      scope: "domain",
      decision: "defer",
      now: NOW + 1,
    });

    expect(result.status).toBe("blocked");
    expect(result.pendingActions).toEqual(["create_filter"]);

    const domain = await store.domains.get(keyFor("acme.test"));
    expect(domain).toMatchObject({
      trustStatus: "blocked",
      trustDecidedAt: NOW,
      pendingActions: ["create_filter"],
    });
  });

  it("throws for an unknown domain", async () => {
    const store = await seed();
    await expect(
      applyDecision(store, {
        subjectId: keyFor("ghost.test"),
        scope: "domain",
        decision: "trust",
        now: NOW,
      }),
    ).rejects.toThrow(/no domain/);
  });
});

describe("applyDecisions — batch ordering (#167)", () => {
  const domainBlock = {
    subjectId: keyFor("acme.test"),
    scope: "domain" as const,
    decision: "block" as const,
    actions: ["create_filter", "delete"] as BlockAction[],
    now: NOW,
  };
  const memberTrust = {
    subjectId: keyFor("a@acme.test"),
    scope: "address" as const,
    decision: "trust" as const,
    now: NOW,
  };

  it.each([
    ["domain decision first", [domainBlock, memberTrust]],
    ["address decision first", [memberTrust, domainBlock]],
  ])(
    "records a kept member as a domain exception regardless of submission order (%s)",
    async (_label, batch) => {
      const store = await seed();
      const outcomes = await applyDecisions(store, batch);
      expect(outcomes.every((o) => o.error === undefined)).toBe(true);

      const domain = await store.domains.get(keyFor("acme.test"));
      const member = await store.senders.get(keyFor("a@acme.test"));
      // The domain lands blocked at domain scope...
      expect(domain?.trustStatus).toBe("blocked");
      expect(domain?.decisionScope).toBe("domain");
      // ...and the kept member is recorded as an exception, so it resolves effectively trusted
      // (not overridden and trashed) — the intended "block the domain, keep this sender" outcome.
      expect(domain?.exceptionAddresses).toContain("a@acme.test");
      const effective = resolveEffectiveDecision({
        addressStatus: member?.trustStatus === "pending" ? null : (member?.trustStatus ?? null),
        addressIsException: domain?.exceptionAddresses.includes("a@acme.test") ?? false,
        domainStatus: domain?.trustStatus === "pending" ? null : (domain?.trustStatus ?? null),
        domainScope: domain?.decisionScope ?? null,
      });
      expect(effective.status).toBe("trusted");
    },
  );

  it("returns outcomes in the original input order", async () => {
    const store = await seed();
    const outcomes = await applyDecisions(store, [memberTrust, domainBlock]);
    expect(outcomes.map((o) => o.input.subjectId)).toEqual([
      keyFor("a@acme.test"),
      keyFor("acme.test"),
    ]);
  });

  it("streams each settled outcome via onSettled (domain-first), then returns input order", async () => {
    const store = await seed();
    const streamed: string[] = [];
    const outcomes = await applyDecisions(store, [memberTrust, domainBlock], {
      onSettled: (o) => streamed.push(o.input.scope),
    });
    // onSettled fires in applied (domain-first) order...
    expect(streamed).toEqual(["domain", "address"]);
    // ...while the returned array stays in input order.
    expect(outcomes.map((o) => o.input.scope)).toEqual(["address", "domain"]);
  });

  it("is per-item resilient — a failing decision doesn't abort the rest", async () => {
    const store = await seed();
    const outcomes = await applyDecisions(store, [
      {
        subjectId: keyFor("missing@acme.test"),
        scope: "address" as const,
        decision: "trust" as const,
        now: NOW,
      },
      memberTrust,
    ]);
    expect(outcomes[0]?.error).toBeDefined(); // unknown sender
    expect(outcomes[1]?.result).toBeDefined(); // the valid decision still applied
    expect((await store.senders.get(keyFor("a@acme.test")))?.trustStatus).toBe("trusted");
  });
});

describe("parent-domain scope (#184)", () => {
  /** A store with a parent rule over example.com, plus a subdomain sender. */
  async function seedSubtree(): Promise<Store> {
    const store = createInMemoryStore();
    await store.domains.put(
      domainFix("example.com", { trustStatus: "blocked", decisionScope: "parentDomain" }),
    );
    await store.domains.put(domainFix("news.example.com"));
    await store.senders.put(senderFix("promo@news.example.com"));
    await store.prompts.put(promptFix("promo@news.example.com"));
    return store;
  }

  it("records an address decided under a parent rule as an exception to it", async () => {
    const store = await seedSubtree();

    await applyDecision(store, {
      subjectId: keyFor("promo@news.example.com"),
      scope: "address",
      decision: "trust",
      now: NOW,
    });

    // Without this the parent rule silently overrides the decision just made, and the
    // sender's mail is trashed anyway — the #167 failure, one level up.
    const parent = await store.domains.get(keyFor("example.com"));
    expect(parent?.exceptionAddresses).toContain("promo@news.example.com");
  });

  it("records an apex address decided under the parent rule on its own record (#184)", async () => {
    const store = createInMemoryStore();
    // The rule lives on `example.com`'s own row — a domain IS its own registrable domain, so
    // there is no separate parent record to find. The carve-out has to land here or nowhere.
    await store.domains.put(
      domainFix("example.com", { trustStatus: "blocked", decisionScope: "parentDomain" }),
    );
    await store.senders.put(senderFix("someone@example.com"));

    await applyDecision(store, {
      subjectId: keyFor("someone@example.com"),
      scope: "address",
      decision: "trust",
      now: NOW,
    });

    // `effectiveBlockedDomains` builds the compiled filter's carve-out from this list, so a
    // missing entry means the filter keeps trashing mail the user just chose to trust —
    // while the Dashboard shows them as trusted.
    const domain = await store.domains.get(keyFor("example.com"));
    expect(domain?.exceptionAddresses).toContain("someone@example.com");
  });

  it("records an address decided under a domain BLOCK covering its subtree (#244)", async () => {
    const store = createInMemoryStore();
    // An exact-domain block, not a parent rule — but `*@example.com` is not an exact match, so
    // its filter and its sweep reach the whole subtree (#210). That makes it a broader rule
    // over this sender, and the carve-out has to land on it.
    await store.domains.put(
      domainFix("example.com", { trustStatus: "blocked", decisionScope: "domain" }),
    );
    // The sender's own subdomain is still undecided, so it holds no rule to carve out of.
    await store.domains.put(domainFix("email.example.com"));
    await store.senders.put(senderFix("statements@email.example.com"));

    await applyDecision(store, {
      subjectId: keyFor("statements@email.example.com"),
      scope: "address",
      decision: "trust",
      now: NOW,
    });

    const blocked = await store.domains.get(keyFor("example.com"));
    expect(blocked?.exceptionAddresses).toContain("statements@email.example.com");
    // Nothing is written to the undecided subdomain — it carries no decision to except from.
    const subdomain = await store.domains.get(keyFor("email.example.com"));
    expect(subdomain?.exceptionAddresses).toEqual([]);
  });

  it("records the carve-out on EVERY block covering the sender, not just the nearest (#244)", async () => {
    const store = createInMemoryStore();
    // Two blocks, each compiling to its own filter and its own sweep. An exception on only one
    // of them leaves the other trashing the mail the user just protected.
    await store.domains.put(
      domainFix("example.com", { trustStatus: "blocked", decisionScope: "domain" }),
    );
    await store.domains.put(
      domainFix("email.example.com", { trustStatus: "blocked", decisionScope: "domain" }),
    );
    await store.senders.put(senderFix("statements@email.example.com"));

    await applyDecision(store, {
      subjectId: keyFor("statements@email.example.com"),
      scope: "address",
      decision: "trust",
      now: NOW,
    });

    expect((await store.domains.get(keyFor("example.com")))?.exceptionAddresses).toContain(
      "statements@email.example.com",
    );
    expect((await store.domains.get(keyFor("email.example.com")))?.exceptionAddresses).toContain(
      "statements@email.example.com",
    );
  });

  it("records nothing on a domain-scope TRUST above the sender (#244)", async () => {
    const store = createInMemoryStore();
    // A trust compiles to no rule at all, so it has no subtree reach to be carved out of.
    await store.domains.put(
      domainFix("example.com", { trustStatus: "trusted", decisionScope: "domain" }),
    );
    await store.senders.put(senderFix("statements@email.example.com"));

    await applyDecision(store, {
      subjectId: keyFor("statements@email.example.com"),
      scope: "address",
      decision: "block",
      now: NOW,
    });

    expect((await store.domains.get(keyFor("example.com")))?.exceptionAddresses).toEqual([]);
  });

  it("records a subdomain decided under a parent rule as an exception to it", async () => {
    const store = await seedSubtree();

    await applyDecision(store, {
      subjectId: keyFor("news.example.com"),
      scope: "domain",
      decision: "trust",
      now: NOW,
    });

    const parent = await store.domains.get(keyFor("example.com"));
    expect(parent?.exceptionDomains).toContain("news.example.com");
  });

  it("resolves the prompts of every sender in the subtree, not just exact-name members", async () => {
    const store = await seedSubtree();

    const result = await applyDecision(store, {
      subjectId: keyFor("example.com"),
      scope: "parentDomain",
      decision: "block",
      now: NOW,
    });

    // The sender is at news.example.com — an exact-name member query would never find it.
    expect(result.resolvedPromptIds).toEqual([keyFor("promo@news.example.com")]);
    const domain = await store.domains.get(keyFor("example.com"));
    expect(domain?.decisionScope).toBe("parentDomain");
  });

  it("throws when parentDomain scope targets a record that is not its own registrable domain (#230)", async () => {
    const store = await seedSubtree();

    // `news.example.com` is a subdomain of the registrable domain `example.com` — a
    // `parentDomain`-scoped decision on it would create a rule `parentDomainRuleFor` can never
    // find, since that lookup is keyed on the registrable domain alone.
    await expect(
      applyDecision(store, {
        subjectId: keyFor("news.example.com"),
        scope: "parentDomain",
        decision: "block",
        now: NOW,
      }),
    ).rejects.toThrow(/own registrable domain/);
  });

  it("applies broadest-first in a batch, so each narrower decision is carved out", async () => {
    const store = createInMemoryStore();
    await store.domains.put(domainFix("example.com"));
    await store.domains.put(domainFix("news.example.com"));
    await store.senders.put(senderFix("vip@news.example.com"));

    // Submitted narrowest-first on purpose: the ordering must not depend on the caller.
    await applyDecisions(store, [
      { subjectId: keyFor("vip@news.example.com"), scope: "address", decision: "trust", now: NOW },
      { subjectId: keyFor("news.example.com"), scope: "domain", decision: "trust", now: NOW },
      { subjectId: keyFor("example.com"), scope: "parentDomain", decision: "block", now: NOW },
    ]);

    const parent = await store.domains.get(keyFor("example.com"));
    expect(parent?.exceptionDomains).toContain("news.example.com");
    expect(parent?.exceptionAddresses).toContain("vip@news.example.com");
    // …and the sender the user kept is effectively trusted, not swept by the parent block.
    const sender = await store.senders.get(keyFor("vip@news.example.com"));
    expect(sender?.trustStatus).toBe("trusted");
  });
});
