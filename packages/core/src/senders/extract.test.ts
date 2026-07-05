// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { keyFor } from "../keys";
import { messageMetaBuilder } from "../testing/builders";
import {
  categorise,
  extractSenders,
  frequencyFor,
  HIGH_VOLUME_THRESHOLD,
  parseAuthResults,
  parseFromHeader,
} from "./extract";

describe("parseFromHeader", () => {
  it("parses a quoted display name with an angle-addr address", () => {
    expect(parseFromHeader('"Acme Sales" <sales@acme.com>')).toEqual({
      email: "sales@acme.com",
      domain: "acme.com",
      displayName: "Acme Sales",
    });
  });

  it("parses an unquoted display name", () => {
    expect(parseFromHeader("Jane Doe <jane@example.org>")).toEqual({
      email: "jane@example.org",
      domain: "example.org",
      displayName: "Jane Doe",
    });
  });

  it("parses a bare address with no display name", () => {
    expect(parseFromHeader("bob@example.com")).toEqual({
      email: "bob@example.com",
      domain: "example.com",
      displayName: null,
    });
  });

  it("lowercases the address and domain", () => {
    expect(parseFromHeader("Bob@Example.COM")).toEqual({
      email: "bob@example.com",
      domain: "example.com",
      displayName: null,
    });
  });

  it("returns null for undefined, empty, or address-less input", () => {
    expect(parseFromHeader(undefined)).toBeNull();
    expect(parseFromHeader("   ")).toBeNull();
    expect(parseFromHeader("not-an-address")).toBeNull();
    expect(parseFromHeader("@nope.com")).toBeNull();
    expect(parseFromHeader("user@localhost")).toBeNull();
  });
});

describe("categorise", () => {
  const base = { hasListUnsubscribe: false, hasListId: false, totalEmails: 1 };

  it("treats CATEGORY_PROMOTIONS as promotional (strongest signal)", () => {
    expect(categorise({ ...base, labelIds: new Set(["INBOX", "CATEGORY_PROMOTIONS"]) })).toBe(
      "promotional",
    );
  });

  it("treats CATEGORY_UPDATES as transactional", () => {
    expect(categorise({ ...base, labelIds: new Set(["CATEGORY_UPDATES"]) })).toBe("transactional");
  });

  it("treats CATEGORY_PERSONAL as personal", () => {
    expect(categorise({ ...base, labelIds: new Set(["CATEGORY_PERSONAL"]) })).toBe("personal");
  });

  it("treats CATEGORY_SOCIAL and CATEGORY_FORUMS as other", () => {
    expect(categorise({ ...base, labelIds: new Set(["CATEGORY_SOCIAL"]) })).toBe("other");
    expect(categorise({ ...base, labelIds: new Set(["CATEGORY_FORUMS"]) })).toBe("other");
  });

  it("falls back to List-Unsubscribe → promotional when no category label", () => {
    expect(categorise({ ...base, labelIds: new Set(["INBOX"]), hasListUnsubscribe: true })).toBe(
      "promotional",
    );
  });

  it("falls back to List-Id → transactional when no unsubscribe", () => {
    expect(categorise({ ...base, labelIds: new Set(["INBOX"]), hasListId: true })).toBe(
      "transactional",
    );
  });

  it("uses frequency for unlabelled non-list senders", () => {
    const labelIds = new Set(["INBOX"]);
    expect(
      categorise({ labelIds, hasListUnsubscribe: false, hasListId: false, totalEmails: 1 }),
    ).toBe("personal");
    expect(
      categorise({
        labelIds,
        hasListUnsubscribe: false,
        hasListId: false,
        totalEmails: HIGH_VOLUME_THRESHOLD,
      }),
    ).toBe("other");
  });
});

describe("extractSenders", () => {
  const NOW = 1_700_000_000_000;

  it("groups messages by sender and denormalises the domain", () => {
    const metas = [
      messageMetaBuilder({ headers: { from: "Jane <jane@acme.com>" }, internalDate: 100 }),
      messageMetaBuilder({ headers: { from: "jane@acme.com" }, internalDate: 300 }),
      messageMetaBuilder({ headers: { from: "Bob <bob@other.com>" }, internalDate: 200 }),
    ];

    const { senders, domains } = extractSenders(metas, NOW);

    const jane = senders.find((s) => s.email === "jane@acme.com");
    expect(jane).toMatchObject({
      id: keyFor("jane@acme.com"),
      domain: "acme.com",
      displayName: "Jane",
      totalEmails: 2,
      trustStatus: "pending",
      firstSeenAt: 100,
      lastSeenAt: 300,
      updatedAt: NOW,
    });
    expect(senders).toHaveLength(2);
    expect(domains).toHaveLength(2);
  });

  it("aggregates per-domain counts across senders", () => {
    const metas = [
      messageMetaBuilder({ headers: { from: "a@shop.com" } }),
      messageMetaBuilder({ headers: { from: "a@shop.com" } }),
      messageMetaBuilder({ headers: { from: "b@shop.com" } }),
    ];

    const { domains } = extractSenders(metas, NOW);
    const shop = domains.find((d) => d.domain === "shop.com");
    expect(shop).toMatchObject({
      id: keyFor("shop.com"),
      senderCount: 2,
      totalEmails: 3,
      exceptionAddresses: [],
    });
  });

  it("ORs list-header signals across a sender's messages", () => {
    const metas = [
      messageMetaBuilder({ headers: { from: "news@promo.com" } }),
      messageMetaBuilder({
        headers: { from: "news@promo.com", listUnsubscribe: "<mailto:unsub@promo.com>" },
      }),
    ];

    const [sender] = extractSenders(metas, NOW).senders;
    expect(sender?.hasListUnsubscribe).toBe(true);
    expect(sender?.category).toBe("promotional");
  });

  it("skips messages whose From cannot be parsed", () => {
    const metas = [
      messageMetaBuilder({ headers: { from: "garbage" } }),
      messageMetaBuilder({ headers: { from: "ok@valid.com" } }),
    ];

    const { senders } = extractSenders(metas, NOW);
    expect(senders).toHaveLength(1);
    expect(senders[0]?.email).toBe("ok@valid.com");
  });

  it("backfills a display name from a later message when the first lacked one", () => {
    const metas = [
      messageMetaBuilder({ headers: { from: "info@brand.com" } }),
      messageMetaBuilder({ headers: { from: "Brand Team <info@brand.com>" } }),
    ];

    const [sender] = extractSenders(metas).senders;
    expect(sender?.displayName).toBe("Brand Team");
  });
});

describe("frequencyFor", () => {
  it("bands the 30-day count into a cadence", () => {
    expect(frequencyFor(25)).toBe("daily");
    expect(frequencyFor(20)).toBe("daily");
    expect(frequencyFor(4)).toBe("weekly");
    expect(frequencyFor(3)).toBe("monthly");
    expect(frequencyFor(1)).toBe("monthly");
    expect(frequencyFor(0)).toBe("rare");
  });
});

describe("parseAuthResults", () => {
  it("reads SPF/DKIM/DMARC pass results", () => {
    expect(parseAuthResults("mx.google.com; spf=pass; dkim=pass; dmarc=pass")).toEqual({
      spf: true,
      dkim: true,
      dmarc: true,
      spoofed: false,
    });
  });

  it("flags spoofing when DMARC fails", () => {
    expect(parseAuthResults("spf=pass; dkim=pass; dmarc=fail").spoofed).toBe(true);
  });

  it("flags spoofing when both SPF and DKIM fail", () => {
    expect(parseAuthResults("spf=fail; dkim=fail").spoofed).toBe(true);
  });

  it("returns all-false for a missing header", () => {
    expect(parseAuthResults(undefined)).toEqual({
      spf: false,
      dkim: false,
      dmarc: false,
      spoofed: false,
    });
  });
});

describe("extractSenders — trust signals", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 0, 31);

  it("derives readRate, starred/spam counts, recency buckets and frequency", () => {
    const metas = [
      messageMetaBuilder({
        headers: { from: "s@x.com" },
        labelIds: ["INBOX", "UNREAD"],
        internalDate: NOW - 5 * DAY,
      }),
      messageMetaBuilder({
        headers: { from: "s@x.com" },
        labelIds: ["INBOX", "STARRED"],
        internalDate: NOW - 40 * DAY,
      }),
      messageMetaBuilder({
        headers: { from: "s@x.com" },
        labelIds: ["INBOX", "SPAM"],
        internalDate: NOW - 200 * DAY,
      }),
    ];

    const [sender] = extractSenders(metas, NOW).senders;
    expect(sender?.totalEmails).toBe(3);
    expect(sender?.readRate).toBeCloseTo(2 / 3, 5); // 1 of 3 unread
    expect(sender?.starredCount).toBe(1);
    expect(sender?.spamMarkedCount).toBe(1);
    expect(sender?.recencyBuckets).toEqual({ d30: 1, d90: 1, d180: 0, older: 1 });
    expect(sender?.frequency).toBe("monthly"); // 1 email in 30d
    expect(sender?.replyCount).toBe(0);
    expect(sender?.inContacts).toBe(false);
  });

  it("uses the most recent authenticated message's auth posture", () => {
    const metas = [
      messageMetaBuilder({
        headers: { from: "a@y.com", authenticationResults: "spf=pass; dkim=pass; dmarc=pass" },
        internalDate: NOW - 10 * DAY,
      }),
      messageMetaBuilder({
        headers: { from: "a@y.com", authenticationResults: "dmarc=fail" },
        internalDate: NOW - 1 * DAY,
      }),
    ];

    const [sender] = extractSenders(metas, NOW).senders;
    expect(sender?.auth.spoofed).toBe(true);
    expect(sender?.auth.dmarc).toBe(false);
  });
});
