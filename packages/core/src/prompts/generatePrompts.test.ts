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
        senderFixture("pending@a.com", "pending"),
        senderFixture("trusted@b.com", "trusted"),
        senderFixture("blocked@c.com", "blocked"),
      ],
      { now: NOW },
    );
    expect(prompts.map((p) => p.senderId)).toEqual([keyFor("pending@a.com")]);
  });

  it("does not prompt a sender covered by a domain decision (#123)", () => {
    const prompts = generatePrompts(
      [
        senderFixture("a@blocked.com", "pending"),
        senderFixture("b@blocked.com", "pending"),
        senderFixture("c@open.com", "pending"),
      ],
      {
        now: NOW,
        domains: [
          domainBuilder("blocked.com", { trustStatus: "blocked", decisionScope: "domain" }),
        ],
      },
    );
    // blocked.com's members are effectively decided → excluded; the undecided domain stays.
    expect(prompts.map((p) => p.senderId)).toEqual([keyFor("c@open.com")]);
  });

  it("still prompts members of an undecided domain — suppression only fires for decided domains (#123)", () => {
    const prompts = generatePrompts(
      [senderFixture("a@open.com", "pending"), senderFixture("b@open.com", "pending")],
      { now: NOW, domains: [domainBuilder("open.com")] }, // default trustStatus: pending
    );
    expect(new Set(prompts.map((p) => p.senderId))).toEqual(
      new Set([keyFor("a@open.com"), keyFor("b@open.com")]),
    );
  });

  it("sets createdAt = now and a 30-day expiresAt, with resolvedAt null", () => {
    const [prompt] = generatePrompts([senderFixture("x@a.com", "pending")], { now: NOW });
    expect(prompt).toMatchObject({
      id: keyFor("x@a.com"),
      senderId: keyFor("x@a.com"),
      createdAt: NOW,
      expiresAt: NOW + PROMPT_TTL_MS,
      resolvedAt: null,
    });
    expect(PROMPT_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("orders prompts by descending priority", () => {
    const prompts = generatePrompts(
      [
        senderFixture("low@a.com", "pending", { totalEmails: 1, frequency: "rare" }),
        senderFixture("high@a.com", "pending", { totalEmails: 100, frequency: "daily" }),
      ],
      { now: NOW },
    );
    expect(prompts[0]?.senderId).toBe(keyFor("high@a.com"));
    expect(prompts[0]!.priorityScore).toBeGreaterThan(prompts[1]!.priorityScore);
  });

  it("returns no prompts when every sender is decided", () => {
    const prompts = generatePrompts([senderFixture("done@a.com", "trusted")], { now: NOW });
    expect(prompts).toEqual([]);
  });
});
