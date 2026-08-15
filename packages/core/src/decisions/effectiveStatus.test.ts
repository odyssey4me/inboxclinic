// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { createInMemoryStore, domainBuilder, senderBuilder } from "../testing";
import type { Domain } from "../store/types";
import {
  coveringRulesFor,
  effectiveBlockedDomains,
  effectiveBlockedSenders,
  effectiveSenderStatus,
  effectiveTrustedSenders,
  resolveSenderGovernance,
} from "./effectiveStatus";
import { keyFor } from "../keys";

describe("effectiveSenderStatus", () => {
  it("returns the raw status when there is no domain override", () => {
    const s = senderBuilder("a@x.test", { trustStatus: "blocked" });
    expect(effectiveSenderStatus(s, undefined)).toBe("blocked");
  });

  it("lets a domain-scope trust override an address block", () => {
    const s = senderBuilder("a@x.test", { trustStatus: "blocked" });
    const d = domainBuilder("x.test", { trustStatus: "trusted", decisionScope: "domain" });
    expect(effectiveSenderStatus(s, d)).toBe("trusted");
  });

  it("honours an address exception over the domain trust", () => {
    const s = senderBuilder("a@x.test", { trustStatus: "blocked" });
    const d = domainBuilder("x.test", {
      trustStatus: "trusted",
      decisionScope: "domain",
      exceptionAddresses: ["a@x.test"],
    });
    expect(effectiveSenderStatus(s, d)).toBe("blocked");
  });

  it("ignores a domain status that isn't a domain-scope decision", () => {
    const s = senderBuilder("a@x.test", { trustStatus: "blocked" });
    const d = domainBuilder("x.test", { trustStatus: "trusted", decisionScope: "address" });
    expect(effectiveSenderStatus(s, d)).toBe("blocked");
  });

  it("lets an apex domain's own parentDomain-scope rule override an already-decided sender (#222)", () => {
    // example.com blocked at parentDomain scope covers its own subtree, including itself —
    // trusting ceo@example.com individually beforehand must not survive the later block.
    const s = senderBuilder("ceo@example.com", { trustStatus: "trusted" });
    const d = domainBuilder("example.com", {
      trustStatus: "blocked",
      decisionScope: "parentDomain",
    });
    expect(effectiveSenderStatus(s, d)).toBe("blocked");
  });

  it("steps aside for an apex sender recorded as an exception to its own subtree rule", () => {
    const s = senderBuilder("ceo@example.com", { trustStatus: "trusted" });
    const d = domainBuilder("example.com", {
      trustStatus: "blocked",
      decisionScope: "parentDomain",
      exceptionAddresses: ["ceo@example.com"],
    });
    expect(effectiveSenderStatus(s, d)).toBe("trusted");
  });
});

describe("resolveSenderGovernance — naming the rule, not just the status (#238)", () => {
  /** The ladder as the UI gets it: every domain record, keyed, then the covering rules. */
  const govern = (sender: Parameters<typeof resolveSenderGovernance>[0], domains: Domain[]) => {
    const byKey = new Map(domains.map((d) => [keyFor(d.domain), d]));
    const senderDomain = sender.email.slice(sender.email.indexOf("@") + 1);
    return resolveSenderGovernance(
      sender,
      byKey.get(keyFor(senderDomain)),
      coveringRulesFor(senderDomain, byKey),
    );
  };

  it("names the block covering a sender from ABOVE, which nothing keyed on the parent rule finds", () => {
    // The case #244 created and this refactor exists to pick up: `example.com` is scoped
    // `domain`, so `parentDomainRuleFor` returns undefined for it and the old hand-derived
    // ladder named no rule at all — beside a status badge reading blocked.
    const result = govern(senderBuilder("statements@email.example.com"), [
      domainBuilder("example.com", { trustStatus: "blocked", decisionScope: "domain" }),
      domainBuilder("email.example.com", { trustStatus: "pending" }),
    ]);

    expect(result.status).toBe("blocked");
    expect(result.governingRule?.domain).toBe("example.com");
    expect(result.carvedOutOf).toBeUndefined();
  });

  it("names the sender's own domain rule when that is what decides it", () => {
    const result = govern(senderBuilder("news@shop.test"), [
      domainBuilder("shop.test", { trustStatus: "blocked", decisionScope: "domain" }),
    ]);

    expect(result.source).toBe("domain");
    expect(result.governingRule?.domain).toBe("shop.test");
  });

  it("names no governing rule, but the rule it is carved out of, when its own decision stands", () => {
    // Trusted under the block, so the carve-out was recorded — the sender's decision wins, and
    // the panel's control is "rejoin that rule" rather than "this rule decides you".
    const result = govern(senderBuilder("vip@shop.test", { trustStatus: "trusted" }), [
      domainBuilder("shop.test", {
        trustStatus: "blocked",
        decisionScope: "domain",
        exceptionAddresses: ["vip@shop.test"],
      }),
    ]);

    expect(result.status).toBe("trusted");
    expect(result.governingRule).toBeUndefined();
    expect(result.carvedOutOf?.domain).toBe("shop.test");
  });

  it("names the broader rule still covering a sender excepted from the nearer one", () => {
    // Excepted from `email.example.com`, but `example.com` was blocked later and never carved
    // this sender out — so that is the rule to name, and resolving only the nearest would have
    // named none while the broader filter went on trashing the mail.
    const result = govern(
      senderBuilder("statements@email.example.com", { trustStatus: "trusted" }),
      [
        domainBuilder("example.com", { trustStatus: "blocked", decisionScope: "domain" }),
        domainBuilder("email.example.com", {
          trustStatus: "blocked",
          decisionScope: "domain",
          exceptionAddresses: ["statements@email.example.com"],
        }),
      ],
    );

    expect(result.status).toBe("blocked");
    expect(result.governingRule?.domain).toBe("example.com");
  });
});

describe("effectiveBlockedSenders", () => {
  it("excludes a domain-trusted sender, keeps exceptions and un-overridden blocks", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("a@shop.test", { trustStatus: "blocked" })); // overridden → out
    await store.senders.put(senderBuilder("b@shop.test", { trustStatus: "blocked" })); // exception → kept
    await store.senders.put(senderBuilder("c@other.test", { trustStatus: "blocked" })); // no domain → kept
    await store.domains.put(
      domainBuilder("shop.test", {
        trustStatus: "trusted",
        decisionScope: "domain",
        exceptionAddresses: ["b@shop.test"],
      }),
    );

    const blocked = await effectiveBlockedSenders(store);
    expect(blocked.map((s) => s.email).sort()).toEqual(["b@shop.test", "c@other.test"]);
  });
});

describe("parent-domain rules (#184)", () => {
  /** `example.com` carrying a rule over its whole subtree. */
  const parentRule = (overrides: Partial<Domain> = {}): Domain =>
    domainBuilder("example.com", {
      trustStatus: "blocked",
      decisionScope: "parentDomain",
      ...overrides,
    });

  it("covers a subdomain's senders that have no narrower decision", async () => {
    const store = createInMemoryStore();
    await store.domains.put(parentRule());
    await store.senders.put(senderBuilder("promo@news.example.com", { trustStatus: "blocked" }));

    const blocked = await effectiveBlockedSenders(store);

    expect(blocked.map((s) => s.email)).toEqual(["promo@news.example.com"]);
  });

  it("outranks a subdomain's own trust decision that it has not carved out", async () => {
    const store = createInMemoryStore();
    await store.domains.put(parentRule());
    // The subdomain was trusted at some point, but the parent rule is the later, broader word.
    await store.domains.put(
      domainBuilder("news.example.com", { trustStatus: "trusted", decisionScope: "domain" }),
    );
    await store.senders.put(senderBuilder("promo@news.example.com", { trustStatus: "pending" }));

    expect(await effectiveTrustedSenders(store)).toEqual([]);
  });

  it("steps aside for a subdomain it records as an exception", async () => {
    const store = createInMemoryStore();
    await store.domains.put(parentRule({ exceptionDomains: ["news.example.com"] }));
    await store.domains.put(
      domainBuilder("news.example.com", { trustStatus: "trusted", decisionScope: "domain" }),
    );
    await store.senders.put(senderBuilder("promo@news.example.com", { trustStatus: "pending" }));

    const trusted = await effectiveTrustedSenders(store);

    expect(trusted.map((s) => s.email)).toEqual(["promo@news.example.com"]);
  });

  it("steps aside for an address it records as an exception", async () => {
    const store = createInMemoryStore();
    await store.domains.put(parentRule({ exceptionAddresses: ["vip@news.example.com"] }));
    await store.senders.put(senderBuilder("vip@news.example.com", { trustStatus: "trusted" }));

    const trusted = await effectiveTrustedSenders(store);

    expect(trusted.map((s) => s.email)).toEqual(["vip@news.example.com"]);
  });

  it("does not reach a different registrable domain that merely shares a suffix", async () => {
    const store = createInMemoryStore();
    await store.domains.put(parentRule());
    // `example.com.au` is its own registrable domain — the coarse Gmail match would catch it,
    // the decision model must not.
    // eslint-disable-next-line local/no-real-domains -- real public suffix, see the note above
    await store.senders.put(senderBuilder("promo@example.com.au", { trustStatus: "pending" }));

    expect(await effectiveBlockedSenders(store)).toEqual([]);
  });

  it("does not let a domain-scope TRUST reach the subtree", async () => {
    const store = createInMemoryStore();
    // A trust about example.com itself. Unlike a block it compiles to no rule at all, so it has
    // no reach to model — and treating it as covering the subtree would have trust-rescue pull
    // subtree mail back out of Trash on no evidence.
    await store.domains.put(
      domainBuilder("example.com", { trustStatus: "trusted", decisionScope: "domain" }),
    );
    await store.senders.put(senderBuilder("promo@news.example.com", { trustStatus: "pending" }));

    expect(await effectiveTrustedSenders(store)).toEqual([]);
  });

  it("does not carve out a subdomain trust it never recorded as an exception (#250)", async () => {
    const store = createInMemoryStore();
    await store.domains.put(parentRule());
    // Trusted before the parent rule existed, so nothing carved it out — Decision 9 makes the
    // rule the later, broader word, and `effectiveTrustedSenders` says so above.
    await store.domains.put(
      domainBuilder("news.example.com", { trustStatus: "trusted", decisionScope: "domain" }),
    );
    await store.senders.put(senderBuilder("promo@news.example.com", { trustStatus: "pending" }));

    // Both halves asserted together: reading raw trust status here spared this subdomain's mail
    // while every other surface reported it blocked, and only asserting one half let them drift.
    expect(await effectiveTrustedSenders(store)).toEqual([]);
    expect((await effectiveBlockedDomains(store))[0]?.excludeSubdomains).toEqual([]);
  });

  it("carves out a subdomain it DOES record as an exception (#250)", async () => {
    const store = createInMemoryStore();
    await store.domains.put(parentRule({ exceptionDomains: ["news.example.com"] }));
    await store.domains.put(
      domainBuilder("news.example.com", { trustStatus: "trusted", decisionScope: "domain" }),
    );
    await store.senders.put(senderBuilder("promo@news.example.com", { trustStatus: "pending" }));

    const trusted = await effectiveTrustedSenders(store);
    expect(trusted.map((s) => s.email)).toEqual(["promo@news.example.com"]);
    expect((await effectiveBlockedDomains(store))[0]?.excludeSubdomains).toEqual([
      "news.example.com",
    ]);
  });

  it("outranks an already-decided APEX sender's own decision via effectiveBlockedDomains (#222)", async () => {
    const store = createInMemoryStore();
    // example.com IS its own registrable domain, so its subtree rule lives on this same
    // record — parentDomainRuleFor finds no separate parent record to resolve above it.
    await store.domains.put(parentRule());
    // Trusted individually before the domain-wide block, and never recorded as an exception.
    await store.senders.put(senderBuilder("ceo@example.com", { trustStatus: "trusted" }));

    const targets = await effectiveBlockedDomains(store);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.excludeAddresses).toEqual([]);
    expect(targets[0]?.blockedMemberAddresses).toEqual(["ceo@example.com"]);
  });
});

describe("a domain-scope block covers its subtree (#210/#244)", () => {
  /** `example.com` blocked as an exact-domain decision — the shape #244 is about. */
  const blockedDomain = (overrides: Partial<Domain> = {}): Domain =>
    domainBuilder("example.com", {
      trustStatus: "blocked",
      decisionScope: "domain",
      ...overrides,
    });

  it("covers a sender at an undecided subdomain, as the filter and the sweep do", async () => {
    const store = createInMemoryStore();
    await store.domains.put(blockedDomain());
    await store.domains.put(domainBuilder("email.example.com", { trustStatus: "pending" }));
    // Trusted before the block, and never recorded as an exception to it — so the later,
    // broader decision is the one that stands, exactly as it does for an apex sender (#222).
    await store.senders.put(
      senderBuilder("statements@email.example.com", { trustStatus: "trusted" }),
    );

    expect(await effectiveTrustedSenders(store)).toEqual([]);
  });

  it("steps aside for an address it records as an exception", async () => {
    const store = createInMemoryStore();
    await store.domains.put(
      blockedDomain({ exceptionAddresses: ["statements@email.example.com"] }),
    );
    await store.domains.put(domainBuilder("email.example.com", { trustStatus: "pending" }));
    await store.senders.put(
      senderBuilder("statements@email.example.com", { trustStatus: "trusted" }),
    );

    const trusted = await effectiveTrustedSenders(store);
    expect(trusted.map((s) => s.email)).toEqual(["statements@email.example.com"]);

    // ...and that exception reaches the filter and the sweep as a carve-out term.
    const targets = await effectiveBlockedDomains(store);
    expect(targets[0]?.excludeAddresses).toEqual(["statements@email.example.com"]);
  });

  it("steps aside for a subdomain separately trusted, matching the `*@sub` carve-out", async () => {
    const store = createInMemoryStore();
    await store.domains.put(blockedDomain());
    await store.domains.put(
      domainBuilder("email.example.com", { trustStatus: "trusted", decisionScope: "domain" }),
    );
    await store.senders.put(
      senderBuilder("statements@email.example.com", { trustStatus: "pending" }),
    );

    // Enforcement carves the subdomain out as `*@email.example.com`, so the status has to agree
    // — reading this sender as blocked while its mail is spared is the divergence #244 closes.
    const trusted = await effectiveTrustedSenders(store);
    expect(trusted.map((s) => s.email)).toEqual(["statements@email.example.com"]);
    expect((await effectiveBlockedDomains(store))[0]?.excludeSubdomains).toEqual([
      "email.example.com",
    ]);
  });

  it("resolves the nearest block the sender is not excepted from", async () => {
    const store = createInMemoryStore();
    // Excepted from the nearer block, but the broader one was decided later and never carved
    // this sender out — so it still covers it, and its filter still sweeps the mail.
    await store.domains.put(blockedDomain());
    await store.domains.put(
      domainBuilder("email.example.com", {
        trustStatus: "blocked",
        decisionScope: "domain",
        exceptionAddresses: ["statements@email.example.com"],
      }),
    );
    await store.senders.put(
      senderBuilder("statements@email.example.com", { trustStatus: "trusted" }),
    );

    expect(await effectiveTrustedSenders(store)).toEqual([]);
  });

  it("counts the whole subtree as members the block covers (#249)", async () => {
    const store = createInMemoryStore();
    await store.domains.put(blockedDomain());
    await store.domains.put(domainBuilder("email.example.com", { trustStatus: "pending" }));
    await store.senders.put(senderBuilder("promo@example.com"));
    await store.senders.put(senderBuilder("offers@email.example.com"));

    // `blockedMemberAddresses` is what the enumerate fallback compiles when the carve-out
    // overflows the criteria budget (#191). An exact-name member list would enumerate only the
    // apex sender, so the overflowing domain would stop blocking its subdomains' mail — while
    // the sweep, still `*@example.com`, went on trashing it.
    const targets = await effectiveBlockedDomains(store);
    expect(targets[0]?.blockedMemberAddresses.sort()).toEqual([
      "offers@email.example.com",
      "promo@example.com",
    ]);
  });

  it("does not reach a domain that merely shares a substring", async () => {
    const store = createInMemoryStore();
    // Named so both hazards are expressible in reserved names: `acme.test` blocked, with a
    // sender at a domain that ENDS with that string and one that BEGINS with it. Neither is
    // under it — the boundary is a dot-separated label, never a substring.
    await store.domains.put(
      domainBuilder("acme.test", { trustStatus: "blocked", decisionScope: "domain" }),
    );
    await store.senders.put(senderBuilder("promo@notacme.test", { trustStatus: "trusted" }));
    await store.senders.put(senderBuilder("promo@acme.testing.test", { trustStatus: "trusted" }));

    const trusted = await effectiveTrustedSenders(store);
    expect(trusted.map((s) => s.email).sort()).toEqual([
      "promo@acme.testing.test",
      "promo@notacme.test",
    ]);
  });
});
