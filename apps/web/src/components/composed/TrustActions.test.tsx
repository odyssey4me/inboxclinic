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

describe("TrustActions — parent-domain scope (#186)", () => {
  const subdomainSender = makeSender({
    id: "news",
    email: "hello@news.example.com",
    domain: "news.example.com",
  });

  const coverage = {
    registrable: "example.com",
    subtree: [
      { domain: "example.com", senderCount: 1 },
      { domain: "news.example.com", senderCount: 2 },
    ],
    siblings: [{ domain: "example.com.au", senderCount: 1 }],
    senderCount: 4,
  };

  function renderWith(scope: DecisionScope, withCoverage = true) {
    const onScopeChange = vi.fn();
    render(
      <TrustActions
        sender={subdomainSender}
        scope={scope}
        onScopeChange={onScopeChange}
        canScopeDomain
        parentCoverage={withCoverage ? coverage : undefined}
        onDecide={vi.fn()}
      />,
    );
    return { onScopeChange };
  }

  it("offers the subtree scope with the number of domains it covers", () => {
    const { onScopeChange } = renderWith("address");

    const option = screen.getByLabelText(/All example\.com subdomains \(2\)/);
    fireEvent.click(option);

    expect(onScopeChange).toHaveBeenCalledWith("parentDomain");
  });

  it("offers nothing extra when there is no subtree rule to make", () => {
    renderWith("address", false);
    expect(screen.queryByLabelText(/All .* subdomains/)).not.toBeInTheDocument();
  });

  it("states the breadth before the decision, not after", () => {
    renderWith("parentDomain");

    // Every domain it reaches, named — a count alone would not let the user judge it.
    expect(screen.getByText(/example\.com \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/news\.example\.com \(2\)/)).toBeInTheDocument();
  });

  it("calls out the domains it catches that are NOT part of the subtree", () => {
    renderWith("parentDomain");

    // The surprising half: a different registrable domain, often a different company, that
    // Gmail's coarse match reaches anyway. Burying this is how a user blocks a stranger.
    expect(screen.getByText(/NOT part of example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/example\.com\.au \(1\)/)).toBeInTheDocument();
  });

  it("admits the match surface is not fully enumerable", () => {
    renderWith("parentDomain");

    // Observed senders are a floor, not the whole set — claiming otherwise would make the
    // list read as exhaustive when a domain nobody has written from cannot appear in it.
    expect(screen.getByText(/have not written yet/)).toBeInTheDocument();
  });

  it("shows no breadth warning until the scope is actually selected", () => {
    renderWith("domain");
    expect(screen.queryByText(/NOT part of example\.com/)).not.toBeInTheDocument();
  });
});
