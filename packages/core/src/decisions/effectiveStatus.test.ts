// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { createInMemoryStore, domainBuilder, senderBuilder } from "../testing";
import { effectiveBlockedSenders, effectiveSenderStatus } from "./effectiveStatus";

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
