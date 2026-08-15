// SPDX-License-Identifier: Apache-2.0
/* eslint-disable local/no-real-domains -- the Public Suffix List itself is the subject: `alice.github.io` not collapsing to `github.io` only means something because `github.io` is a real PRIVATE-section entry */
import { describe, expect, it } from "vitest";

import { publicSuffix, registrableDomain, sameRegistrableDomain } from "./registrableDomain";

describe("registrableDomain", () => {
  it("reduces a subdomain to its registrable domain", () => {
    expect(registrableDomain("news.example.com")).toBe("example.com");
    expect(registrableDomain("email.mkt.example.com")).toBe("example.com");
    expect(registrableDomain("example.com")).toBe("example.com");
  });

  it("keeps multi-label public suffixes whole (the reason a PSL is required)", () => {
    // "the last two labels" would give `co.uk` and group every UK company as one.
    expect(registrableDomain("foo.co.uk")).toBe("foo.co.uk");
    expect(registrableDomain("mail.foo.co.uk")).toBe("foo.co.uk");
    expect(registrableDomain("bar.com.au")).toBe("bar.com.au");
  });

  it("treats each tenant of a hosting suffix as its own organisation (#136)", () => {
    // tldts defaults to ICANN-only suffixes, under which these collapse to `github.io` /
    // `pages.dev` — one tenant's rule would then cover every other tenant.
    expect(registrableDomain("alice.github.io")).toBe("alice.github.io");
    expect(registrableDomain("bob.github.io")).toBe("bob.github.io");
    expect(registrableDomain("app.alice.github.io")).toBe("alice.github.io");
    expect(registrableDomain("site.pages.dev")).toBe("site.pages.dev");
    expect(sameRegistrableDomain("alice.github.io", "bob.github.io")).toBe(false);
  });

  it("returns null when there is no registrable domain to rule on", () => {
    expect(registrableDomain("co.uk")).toBeNull(); // a bare public suffix
    expect(registrableDomain("github.io")).toBeNull();
    // Not every `<label>.com` is a domain someone can own: `za.com` is itself a listed
    // suffix, so it has no eTLD+1 — only something under it does.
    expect(registrableDomain("za.com")).toBeNull();
    expect(registrableDomain("shop.za.com")).toBe("shop.za.com");
    expect(registrableDomain("1.2.3.4")).toBeNull(); // an IP address
    expect(registrableDomain("localhost")).toBeNull();
    expect(registrableDomain("")).toBeNull();
    expect(registrableDomain("   ")).toBeNull();
  });

  it("normalises case and surrounding whitespace", () => {
    expect(registrableDomain("  News.EXAMPLE.com  ")).toBe("example.com");
    expect(publicSuffix("  Foo.CO.UK ")).toBe("co.uk");
  });

  it("distinguishes a trailing-label sibling from the domain itself (#182)", () => {
    // The pair Gmail's coarse `from:` matching conflates — the app must not.
    expect(registrableDomain("apple.com")).toBe("apple.com");
    expect(registrableDomain("apple.com.au")).toBe("apple.com.au");
    expect(sameRegistrableDomain("apple.com", "apple.com.au")).toBe(false);
    expect(sameRegistrableDomain("id.apple.com", "apple.com")).toBe(true);
  });
});

describe("publicSuffix", () => {
  it("returns the suffix, including multi-label and private ones", () => {
    expect(publicSuffix("news.example.com")).toBe("com");
    expect(publicSuffix("foo.co.uk")).toBe("co.uk");
    expect(publicSuffix("alice.github.io")).toBe("github.io");
  });

  it("returns null for input with no suffix in the list", () => {
    expect(publicSuffix("1.2.3.4")).toBeNull();
    expect(publicSuffix("")).toBeNull();
  });
});

describe("sameRegistrableDomain", () => {
  it("groups subdomains of one organisation together", () => {
    expect(sameRegistrableDomain("news.example.com", "mail.example.com")).toBe(true);
    expect(sameRegistrableDomain("example.com", "t.example.com")).toBe(true);
  });

  it("never groups two hosts that are only a shared public suffix", () => {
    // A shared suffix is exactly what does NOT imply shared ownership.
    expect(sameRegistrableDomain("co.uk", "co.uk")).toBe(false);
    expect(sameRegistrableDomain("a.com", "b.com")).toBe(false);
  });
});
