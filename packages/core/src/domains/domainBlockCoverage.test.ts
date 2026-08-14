// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { domainBlockCoverage } from "./domainBlockCoverage";

const senders = (...domains: string[]) => domains.map((domain) => ({ domain }));

describe("domainBlockCoverage", () => {
  it("reports the subdomains a domain block reaches, the domain itself first", () => {
    const coverage = domainBlockCoverage(
      "monzo.com",
      senders(
        "monzo.com",
        "email.monzo.com",
        "email.monzo.com",
        "email.monzo.com",
        "customercontent.monzo.com",
      ),
    );

    // The subject leads because it is what the user named; the rest is what comes with it,
    // busiest first, so the biggest surprise is the most visible.
    expect(coverage.covered).toEqual([
      { domain: "monzo.com", senderCount: 1 },
      { domain: "email.monzo.com", senderCount: 3 },
      { domain: "customercontent.monzo.com", senderCount: 1 },
    ]);
    expect(coverage.senderCount).toBe(5);
  });

  it("does not claim domains outside the subtree", () => {
    const coverage = domainBlockCoverage(
      "monzo.com",
      // A lookalike, a prefix-sharing sibling, and a spoof. `*@monzo.com` was measured to span
      // the subtree (#210) — nothing has shown it reaching any of these, so it must not say so.
      senders("monzo.com", "notmonzo.com", "monzo.com.au", "monzo.com.evil.com"),
    );

    expect(coverage.covered).toEqual([{ domain: "monzo.com", senderCount: 1 }]);
    expect(coverage.senderCount).toBe(1);
  });

  it("separates a subdomain the user separately decided, which enforcement carves out", () => {
    const coverage = domainBlockCoverage(
      "monzo.com",
      senders("monzo.com", "email.monzo.com", "ads.monzo.com"),
      ["email.monzo.com"],
    );

    expect(coverage.covered.map((d) => d.domain)).toEqual(["monzo.com", "ads.monzo.com"]);
    expect(coverage.carvedOut).toEqual([{ domain: "email.monzo.com", senderCount: 1 }]);
    // The count is what the block would ACT on, so a carve-out has to come out of it.
    expect(coverage.senderCount).toBe(2);
  });

  it("takes a carved-out subdomain's own subtree with it, as the *@sub exclusion does", () => {
    const coverage = domainBlockCoverage(
      "monzo.com",
      senders("monzo.com", "email.monzo.com", "eu.email.monzo.com"),
      ["email.monzo.com"],
    );

    expect(coverage.covered.map((d) => d.domain)).toEqual(["monzo.com"]);
    expect(coverage.carvedOut.map((d) => d.domain)).toEqual([
      "email.monzo.com",
      "eu.email.monzo.com",
    ]);
  });

  it("ignores a 'carve-out' that is not actually under the domain", () => {
    const coverage = domainBlockCoverage("monzo.com", senders("monzo.com", "email.monzo.com"), [
      "monzo.com", // the subject itself is not a carve-out from itself
      "elsewhere.com",
    ]);

    expect(coverage.covered.map((d) => d.domain)).toEqual(["monzo.com", "email.monzo.com"]);
    expect(coverage.carvedOut).toEqual([]);
  });

  it("reports just the domain when nothing under it has been seen", () => {
    const coverage = domainBlockCoverage("shop.com", senders("shop.com", "shop.com"));

    // Callers use this to decide whether the breadth is worth stating at all: one entry means
    // the decision reaches nothing the user didn't name — though a future subdomain still would.
    expect(coverage.covered).toEqual([{ domain: "shop.com", senderCount: 2 }]);
  });

  it("is case- and whitespace-insensitive about hosts", () => {
    const coverage = domainBlockCoverage("Monzo.com", senders(" EMAIL.Monzo.com "), []);

    expect(coverage.covered).toEqual([{ domain: "email.monzo.com", senderCount: 1 }]);
  });
});
