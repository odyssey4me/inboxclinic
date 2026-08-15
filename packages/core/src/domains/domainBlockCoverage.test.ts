// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { domainBlockCoverage } from "./domainBlockCoverage";

const senders = (...domains: string[]) => domains.map((domain) => ({ domain }));

describe("domainBlockCoverage", () => {
  it("reports the subdomains a domain block reaches, the domain itself first", () => {
    const coverage = domainBlockCoverage(
      "mybank.test",
      senders(
        "mybank.test",
        "email.mybank.test",
        "email.mybank.test",
        "email.mybank.test",
        "customercontent.mybank.test",
      ),
    );

    // The subject leads because it is what the user named; the rest is what comes with it,
    // busiest first, so the biggest surprise is the most visible.
    expect(coverage.covered).toEqual([
      { domain: "mybank.test", senderCount: 1 },
      { domain: "email.mybank.test", senderCount: 3 },
      { domain: "customercontent.mybank.test", senderCount: 1 },
    ]);
    expect(coverage.senderCount).toBe(5);
  });

  it("does not claim domains outside the subtree", () => {
    const coverage = domainBlockCoverage(
      "mybank.test",
      // A lookalike, a prefix-sharing sibling, and a spoof. `*@mybank.test` was measured to span
      // the subtree (#210) — nothing has shown it reaching any of these, so it must not say so.
      senders("mybank.test", "notmybank.test", "mybank.testing.test", "mybank.test.evil.test"),
    );

    expect(coverage.covered).toEqual([{ domain: "mybank.test", senderCount: 1 }]);
    expect(coverage.senderCount).toBe(1);
  });

  it("separates a subdomain the user separately decided, which enforcement carves out", () => {
    const coverage = domainBlockCoverage(
      "mybank.test",
      senders("mybank.test", "email.mybank.test", "ads.mybank.test"),
      ["email.mybank.test"],
    );

    expect(coverage.covered.map((d) => d.domain)).toEqual(["mybank.test", "ads.mybank.test"]);
    expect(coverage.carvedOut).toEqual([{ domain: "email.mybank.test", senderCount: 1 }]);
    // The count is what the block would ACT on, so a carve-out has to come out of it.
    expect(coverage.senderCount).toBe(2);
  });

  it("takes a carved-out subdomain's own subtree with it, as the *@sub exclusion does", () => {
    const coverage = domainBlockCoverage(
      "mybank.test",
      senders("mybank.test", "email.mybank.test", "eu.email.mybank.test"),
      ["email.mybank.test"],
    );

    expect(coverage.covered.map((d) => d.domain)).toEqual(["mybank.test"]);
    expect(coverage.carvedOut.map((d) => d.domain)).toEqual([
      "email.mybank.test",
      "eu.email.mybank.test",
    ]);
  });

  it("ignores a 'carve-out' that is not actually under the domain", () => {
    const coverage = domainBlockCoverage("mybank.test", senders("mybank.test", "email.mybank.test"), [
      "mybank.test", // the subject itself is not a carve-out from itself
      "elsewhere.test",
    ]);

    expect(coverage.covered.map((d) => d.domain)).toEqual(["mybank.test", "email.mybank.test"]);
    expect(coverage.carvedOut).toEqual([]);
  });

  it("reports just the domain when nothing under it has been seen", () => {
    const coverage = domainBlockCoverage("shop.test", senders("shop.test", "shop.test"));

    // Callers use this to decide whether the breadth is worth stating at all: one entry means
    // the decision reaches nothing the user didn't name — though a future subdomain still would.
    expect(coverage.covered).toEqual([{ domain: "shop.test", senderCount: 2 }]);
  });

  it("is case- and whitespace-insensitive about hosts", () => {
    const coverage = domainBlockCoverage("Mybank.test", senders(" EMAIL.Mybank.test "), []);

    expect(coverage.covered).toEqual([{ domain: "email.mybank.test", senderCount: 1 }]);
  });
});
