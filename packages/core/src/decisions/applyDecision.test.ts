// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { keyFor } from "../keys";
import { createInMemoryStore } from "../testing";
import type { Domain, Prompt, Sender, Store } from "../store";
import { applyDecision, DEFER_DECAY } from "./applyDecision";
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

/** A store seeded with two acme.com senders + one other.com sender, all with prompts. */
async function seed(): Promise<Store> {
  const store = createInMemoryStore();
  await store.senders.bulkPut([
    senderFix("a@acme.com"),
    senderFix("b@acme.com"),
    senderFix("solo@other.com", { hasListUnsubscribe: true, category: "promotional" }),
  ]);
  await store.domains.bulkPut([
    domainFix("acme.com", { senderCount: 2, totalEmails: 10 }),
    domainFix("other.com"),
  ]);
  await store.prompts.bulkPut([
    promptFix("a@acme.com"),
    promptFix("b@acme.com"),
    promptFix("solo@other.com"),
  ]);
  return store;
}

describe("applyDecision — address scope", () => {
  it("records a Trust decision and resolves the prompt", async () => {
    const store = await seed();
    const result = await applyDecision(store, {
      subjectId: keyFor("a@acme.com"),
      scope: "address",
      decision: "trust",
      now: NOW,
    });

    expect(result.status).toBe("trusted");
    expect(result.resolvedPromptIds).toEqual([keyFor("a@acme.com")]);

    const sender = await store.senders.get(keyFor("a@acme.com"));
    expect(sender).toMatchObject({
      trustStatus: "trusted",
      trustDecidedAt: NOW,
      decisionScope: "address",
    });
    expect(sender?.decisionContext).toMatchObject({ decidedVia: "workflow", category: "personal" });
    expect((await store.prompts.get(keyFor("a@acme.com")))?.resolvedAt).toBe(NOW);
  });

  it("stores Block actions as pending without touching Gmail", async () => {
    const store = await seed();
    const result = await applyDecision(store, {
      subjectId: keyFor("solo@other.com"),
      scope: "address",
      decision: "block",
      actions: ["unsubscribe", "create_filter"],
      decidedVia: "dashboard",
      now: NOW,
    });

    expect(result.status).toBe("blocked");
    expect(result.pendingActions).toEqual(["unsubscribe", "create_filter"]);

    const sender = await store.senders.get(keyFor("solo@other.com"));
    expect(sender?.trustStatus).toBe("blocked");
    expect(sender?.pendingActions).toEqual(["unsubscribe", "create_filter"]);
    expect(sender?.decisionContext?.decidedVia).toBe("dashboard");
    expect((await store.prompts.get(keyFor("solo@other.com")))?.resolvedAt).toBe(NOW);
  });

  it("defers: decays priority, marks deferredAt, leaves the prompt unresolved", async () => {
    const store = await seed();
    const before = await store.prompts.get(keyFor("a@acme.com"));

    const result = await applyDecision(store, {
      subjectId: keyFor("a@acme.com"),
      scope: "address",
      decision: "defer",
      now: NOW,
    });

    expect(result.status).toBe("pending");
    expect(result.deferredPromptIds).toEqual([keyFor("a@acme.com")]);

    const after = await store.prompts.get(keyFor("a@acme.com"));
    expect(after?.resolvedAt).toBeNull();
    expect(after?.deferredAt).toBe(NOW);
    expect(after?.priorityScore).toBeCloseTo(before!.priorityScore * DEFER_DECAY, 5);
    expect((await store.senders.get(keyFor("a@acme.com")))?.trustStatus).toBe("pending");
  });

  it("throws for an unknown sender", async () => {
    const store = await seed();
    await expect(
      applyDecision(store, {
        subjectId: keyFor("ghost@nowhere.com"),
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
      subjectId: keyFor("acme.com"),
      scope: "domain",
      decision: "block",
      actions: ["create_filter"],
      now: NOW,
    });

    expect(result.status).toBe("blocked");
    expect(result.resolvedPromptIds.sort()).toEqual(
      [keyFor("a@acme.com"), keyFor("b@acme.com")].sort(),
    );

    const domain = await store.domains.get(keyFor("acme.com"));
    expect(domain).toMatchObject({ trustStatus: "blocked", decisionScope: "domain" });
    expect(domain?.pendingActions).toEqual(["create_filter"]);
    expect((await store.prompts.get(keyFor("a@acme.com")))?.resolvedAt).toBe(NOW);
    expect((await store.prompts.get(keyFor("b@acme.com")))?.resolvedAt).toBe(NOW);
    // A sender in a different domain is untouched.
    expect((await store.prompts.get(keyFor("solo@other.com")))?.resolvedAt).toBeNull();
  });

  it("skips address exceptions when resolving member prompts", async () => {
    const store = createInMemoryStore();
    await store.senders.bulkPut([senderFix("a@acme.com"), senderFix("b@acme.com")]);
    await store.domains.put(domainFix("acme.com", { exceptionAddresses: ["a@acme.com"] }));
    await store.prompts.bulkPut([promptFix("a@acme.com"), promptFix("b@acme.com")]);

    const result = await applyDecision(store, {
      subjectId: keyFor("acme.com"),
      scope: "domain",
      decision: "block",
      now: NOW,
    });

    expect(result.resolvedPromptIds).toEqual([keyFor("b@acme.com")]);
    expect((await store.prompts.get(keyFor("a@acme.com")))?.resolvedAt).toBeNull();
  });

  it("records an address decision under a domain decision as an explicit exception", async () => {
    const store = await seed();
    await applyDecision(store, {
      subjectId: keyFor("acme.com"),
      scope: "domain",
      decision: "trust",
      now: NOW,
    });
    await applyDecision(store, {
      subjectId: keyFor("a@acme.com"),
      scope: "address",
      decision: "block",
      now: NOW,
    });

    const domain = await store.domains.get(keyFor("acme.com"));
    expect(domain?.exceptionAddresses).toContain("a@acme.com");

    const sender = await store.senders.get(keyFor("a@acme.com"));
    const effective = resolveEffectiveDecision({
      addressStatus: sender!.trustStatus,
      addressIsException: domain!.exceptionAddresses.includes(sender!.email),
      domainStatus: domain!.trustStatus,
      domainScope: domain!.decisionScope,
    });
    expect(effective).toEqual({ status: "blocked", source: "address" });
  });

  it("defers a whole domain, decaying every member prompt", async () => {
    const store = await seed();
    const result = await applyDecision(store, {
      subjectId: keyFor("acme.com"),
      scope: "domain",
      decision: "defer",
      now: NOW,
    });

    expect(result.status).toBe("pending");
    expect(result.deferredPromptIds.sort()).toEqual(
      [keyFor("a@acme.com"), keyFor("b@acme.com")].sort(),
    );
    expect((await store.prompts.get(keyFor("a@acme.com")))?.deferredAt).toBe(NOW);
  });

  it("throws for an unknown domain", async () => {
    const store = await seed();
    await expect(
      applyDecision(store, {
        subjectId: keyFor("ghost.com"),
        scope: "domain",
        decision: "trust",
        now: NOW,
      }),
    ).rejects.toThrow(/no domain/);
  });
});
