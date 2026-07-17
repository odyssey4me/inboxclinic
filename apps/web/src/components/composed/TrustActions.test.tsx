// SPDX-License-Identifier: Apache-2.0
import type { Decision, DecisionScope, Sender } from "@inboxclinic/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TrustActions } from "./TrustActions";

const NOW = 1_700_000_000_000;

function makeSender(overrides: Partial<Sender>): Sender {
  return {
    id: overrides.email ?? "sender",
    email: "sender@example.com",
    domain: "example.com",
    displayName: null,
    category: "other",
    trustStatus: "pending",
    totalEmails: 1,
    hasListUnsubscribe: false,
    hasListId: false,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    updatedAt: NOW,
    readRate: null,
    starredCount: 0,
    spamMarkedCount: 0,
    deletedUnreadCount: 0,
    coveredByBlockFilter: false,
    replyCount: 0,
    inContacts: false,
    frequency: "rare",
    recencyBuckets: { d30: 1, d90: 0, d180: 0, older: 0 },
    auth: { spf: true, dkim: true, dmarc: true, spoofed: false },
    trustDecidedAt: null,
    decisionScope: null,
    decisionContext: null,
    pendingActions: [],
    ...overrides,
  };
}

// hasListUnsubscribe + promotional -> defaults to ["unsubscribe", "create_filter", "archive"].
const senderA = makeSender({
  id: "a",
  email: "news@promo.com",
  domain: "promo.com",
  category: "promotional",
  hasListUnsubscribe: true,
});

// no list-unsubscribe + transactional -> defaults to ["create_filter"] only.
const senderB = makeSender({
  id: "b",
  email: "receipts@shop.com",
  domain: "shop.com",
  category: "transactional",
  hasListUnsubscribe: false,
});

interface HarnessProps {
  sender: Sender;
  onDecide: (decision: Decision, actions: string[]) => void;
}

function Harness({ sender, onDecide }: HarnessProps) {
  return (
    <TrustActions
      sender={sender}
      scope={"address" satisfies DecisionScope}
      onScopeChange={() => {}}
      canScopeDomain={false}
      onDecide={onDecide}
    />
  );
}

describe("TrustActions", () => {
  it("does not carry a customized block selection over to a new sender", () => {
    const onDecide = vi.fn();
    const { rerender } = render(<Harness sender={senderA} onDecide={onDecide} />);

    // Customize sender A's block: uncheck "Create filter" (checked by default).
    fireEvent.click(screen.getByRole("button", { name: /customize block/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /create filter/i }));
    expect(screen.getByRole("checkbox", { name: /create filter/i })).not.toBeChecked();

    // Advance to sender B — same component instance, new `sender` prop (no remount).
    rerender(<Harness sender={senderB} onDecide={onDecide} />);

    // The customize panel should not leak A's open state or stale selection into B.
    expect(screen.queryByRole("checkbox", { name: /create filter/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /customize block/i }));
    expect(screen.getByRole("checkbox", { name: /create filter/i })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: /block with these actions/i }));
    expect(onDecide).toHaveBeenCalledWith("block", ["create_filter"]);
  });

  it("offers defer only for a pending subject", () => {
    const onDecide = vi.fn();
    const { rerender } = render(<Harness sender={senderA} onDecide={onDecide} />);
    expect(screen.getByRole("button", { name: /not sure \(defer\)/i })).toBeInTheDocument();

    rerender(
      <Harness sender={makeSender({ ...senderA, trustStatus: "trusted" })} onDecide={onDecide} />,
    );
    expect(screen.queryByRole("button", { name: /not sure \(defer\)/i })).not.toBeInTheDocument();

    rerender(
      <Harness sender={makeSender({ ...senderA, trustStatus: "blocked" })} onDecide={onDecide} />,
    );
    expect(screen.queryByRole("button", { name: /not sure \(defer\)/i })).not.toBeInTheDocument();
  });
});
