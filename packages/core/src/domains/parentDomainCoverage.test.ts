// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { parentDomainCoverage } from "./parentDomainCoverage";

const from = (...domains: string[]): { domain: string }[] => domains.map((domain) => ({ domain }));

describe("parentDomainCoverage", () => {
  it("groups the subtree a parent rule is meant to cover", () => {
    const coverage = parentDomainCoverage(
      "news.example.com",
      from("example.com", "news.example.com", "news.example.com", "mail.example.com"),
    );

    expect(coverage?.registrable).toBe("example.com");
    expect(coverage?.subtree).toEqual([
      { domain: "example.com", senderCount: 1 },
      { domain: "mail.example.com", senderCount: 1 },
      { domain: "news.example.com", senderCount: 2 },
    ]);
    expect(coverage?.senderCount).toBe(4);
  });

  it("separates a prefix-sharing sibling from the subtree it is not part of", () => {
    // The pair Gmail's coarse match conflates: `apple.com.au` is a different registrable
    // domain — often a different company — and the user has to be told before deciding.
    const coverage = parentDomainCoverage(
      "id.apple.com",
      from("apple.com", "id.apple.com", "apple.com.au"),
    );

    expect(coverage?.subtree.map((d) => d.domain)).toEqual(["apple.com", "id.apple.com"]);
    expect(coverage?.siblings).toEqual([{ domain: "apple.com.au", senderCount: 1 }]);
  });

  it("does not mistake a partial-label lookalike for either group", () => {
    // `applebees.com` shares a prefix but not a label boundary, and Gmail's match is
    // whole-token — so listing it would warn about a domain the rule never touches.
    const coverage = parentDomainCoverage("apple.com", from("apple.com", "applebees.com"));

    expect(coverage?.subtree.map((d) => d.domain)).toEqual(["apple.com"]);
    expect(coverage?.siblings).toEqual([]);
  });

  it("keeps tenants of a hosting suffix apart", () => {
    // Each tenant is its own registrable domain, so a rule on one covers only that one.
    const coverage = parentDomainCoverage(
      "app.alice.github.io",
      from("alice.github.io", "app.alice.github.io", "bob.github.io"),
    );

    expect(coverage?.registrable).toBe("alice.github.io");
    expect(coverage?.subtree.map((d) => d.domain)).toEqual([
      "alice.github.io",
      "app.alice.github.io",
    ]);
    expect(coverage?.siblings).toEqual([]);
  });

  it("returns null when no parent rule could exist", () => {
    // A bare public suffix belongs to nobody, so there is nothing to key a rule on.
    expect(parentDomainCoverage("co.uk", from("co.uk"))).toBeNull();
    expect(parentDomainCoverage("1.2.3.4", from("1.2.3.4"))).toBeNull();
  });

  it("covers a multi-label public suffix as one organisation", () => {
    const coverage = parentDomainCoverage(
      "shop.foo.co.uk",
      from("foo.co.uk", "shop.foo.co.uk", "bar.co.uk"),
    );

    expect(coverage?.registrable).toBe("foo.co.uk");
    expect(coverage?.subtree.map((d) => d.domain)).toEqual(["foo.co.uk", "shop.foo.co.uk"]);
    // `bar.co.uk` is a different company entirely, and shares only the public suffix.
    expect(coverage?.siblings).toEqual([]);
  });
});
