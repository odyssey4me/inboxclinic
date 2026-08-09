// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { createInMemoryStore, domainBuilder, senderBuilder } from "../testing";
import type { Domain } from "../store/types";
import {
  effectiveBlockedSenders,
  effectiveSenderStatus,
  effectiveTrustedSenders,
} from "./effectiveStatus";

describe("effectiveSenderStatus", () => {
  it("returns the raw status when there is no domain override", () => {
    const s = senderBuilder("a@x.com", { trustStatus: "blocked" });
    expect(effectiveSenderStatus(s, undefined)).toBe("blocked");
  });

  it("lets a domain-scope trust override an address block", () => {
    const s = senderBuilder("a@x.com", { trustStatus: "blocked" });
    const d = domainBuilder("x.com", { trustStatus: "trusted", decisionScope: "domain" });
    expect(effectiveSenderStatus(s, d)).toBe("trusted");
  });

  it("honours an address exception over the domain trust", () => {
    const s = senderBuilder("a@x.com", { trustStatus: "blocked" });
    const d = domainBuilder("x.com", {
      trustStatus: "trusted",
      decisionScope: "domain",
      exceptionAddresses: ["a@x.com"],
    });
    expect(effectiveSenderStatus(s, d)).toBe("blocked");
  });

  it("ignores a domain status that isn't a domain-scope decision", () => {
    const s = senderBuilder("a@x.com", { trustStatus: "blocked" });
    const d = domainBuilder("x.com", { trustStatus: "trusted", decisionScope: "address" });
    expect(effectiveSenderStatus(s, d)).toBe("blocked");
  });
});

describe("effectiveBlockedSenders", () => {
  it("excludes a domain-trusted sender, keeps exceptions and un-overridden blocks", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("a@shop.com", { trustStatus: "blocked" })); // overridden → out
    await store.senders.put(senderBuilder("b@shop.com", { trustStatus: "blocked" })); // exception → kept
    await store.senders.put(senderBuilder("c@other.com", { trustStatus: "blocked" })); // no domain → kept
    await store.domains.put(
      domainBuilder("shop.com", {
        trustStatus: "trusted",
        decisionScope: "domain",
        exceptionAddresses: ["b@shop.com"],
      }),
    );

    const blocked = await effectiveBlockedSenders(store);
    expect(blocked.map((s) => s.email).sort()).toEqual(["b@shop.com", "c@other.com"]);
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
    await store.senders.put(senderBuilder("promo@example.com.au", { trustStatus: "pending" }));

    expect(await effectiveBlockedSenders(store)).toEqual([]);
  });

  it("ignores a same-name record that is NOT scoped to the subtree", async () => {
    const store = createInMemoryStore();
    // A decision about example.com itself, not a rule over everything beneath it.
    await store.domains.put(
      domainBuilder("example.com", { trustStatus: "blocked", decisionScope: "domain" }),
    );
    await store.senders.put(senderBuilder("promo@news.example.com", { trustStatus: "pending" }));

    expect(await effectiveBlockedSenders(store)).toEqual([]);
  });
});
