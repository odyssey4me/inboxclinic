// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { keyFor } from "../keys";
import { domainBuilder } from "../testing";
import type { Sender, TrustStatus } from "../store/types";
import { generatePrompts, PROMPT_TTL_MS } from "./generatePrompts";

const NOW = 1_700_000_000_000;

function senderFixture(
  email: string,
  trustStatus: TrustStatus,
  overrides: Partial<Sender> = {},
): Sender {
  return {
    id: keyFor(email),
    email,
    domain: email.slice(email.indexOf("@") + 1),
    displayName: null,
    category: "personal",
    trustStatus,
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

describe("generatePrompts", () => {
  it("creates a prompt only for undecided (pending) senders", () => {
    const prompts = generatePrompts(
      [
        senderFixture("pending@a.test", "pending"),
        senderFixture("trusted@b.test", "trusted"),
        senderFixture("blocked@c.test", "blocked"),
      ],
      { now: NOW },
    );
    expect(prompts.map((p) => p.senderId)).toEqual([keyFor("pending@a.test")]);
  });

  it("does not prompt a sender covered by a domain decision (#123)", () => {
    const prompts = generatePrompts(
      [
        senderFixture("a@blocked.test", "pending"),
        senderFixture("b@blocked.test", "pending"),
        senderFixture("c@open.test", "pending"),
      ],
      {
        now: NOW,
        domains: [
          domainBuilder("blocked.test", { trustStatus: "blocked", decisionScope: "domain" }),
        ],
      },
    );
    // blocked.test's members are effectively decided → excluded; the undecided domain stays.
    expect(prompts.map((p) => p.senderId)).toEqual([keyFor("c@open.test")]);
  });

  it("excludes a decided per-address exception like any decided sender (#123)", () => {
    const prompts = generatePrompts(
      [
        senderFixture("keep@blocked.test", "trusted"), // own address decision → an exception
        senderFixture("other@blocked.test", "pending"), // covered by the domain block
      ],
      {
        now: NOW,
        domains: [
          domainBuilder("blocked.test", {
            trustStatus: "blocked",
            decisionScope: "domain",
            exceptionAddresses: ["keep@blocked.test"],
          }),
        ],
      },
    );
    // The exception's own (trusted) decision wins → excluded; the other member is
    // domain-covered → excluded. Neither is re-prompted.
    expect(prompts).toHaveLength(0);
  });

  it("still prompts members of an undecided domain — suppression only fires for decided domains (#123)", () => {
    const prompts = generatePrompts(
      [senderFixture("a@open.test", "pending"), senderFixture("b@open.test", "pending")],
      { now: NOW, domains: [domainBuilder("open.test")] }, // default trustStatus: pending
    );
    expect(new Set(prompts.map((p) => p.senderId))).toEqual(
      new Set([keyFor("a@open.test"), keyFor("b@open.test")]),
    );
  });

  it("sets createdAt = now and a 30-day expiresAt, with resolvedAt null", () => {
    const [prompt] = generatePrompts([senderFixture("x@a.test", "pending")], { now: NOW });
    expect(prompt).toMatchObject({
      id: keyFor("x@a.test"),
      senderId: keyFor("x@a.test"),
      createdAt: NOW,
      expiresAt: NOW + PROMPT_TTL_MS,
      resolvedAt: null,
    });
    expect(PROMPT_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("orders prompts by descending priority", () => {
    const prompts = generatePrompts(
      [
        senderFixture("low@a.test", "pending", { totalEmails: 1, frequency: "rare" }),
        senderFixture("high@a.test", "pending", { totalEmails: 100, frequency: "daily" }),
      ],
      { now: NOW },
    );
    expect(prompts[0]?.senderId).toBe(keyFor("high@a.test"));
    expect(prompts[0]!.priorityScore).toBeGreaterThan(prompts[1]!.priorityScore);
  });

  it("returns no prompts when every sender is decided", () => {
    const prompts = generatePrompts([senderFixture("done@a.test", "trusted")], { now: NOW });
    expect(prompts).toEqual([]);
  });
});
