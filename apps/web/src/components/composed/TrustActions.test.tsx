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

    // One subdomain: `example.com` is in the subtree but is not a subdomain of itself.
    const option = screen.getByLabelText(/All example\.com subdomains \(1\)/);
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
    // Hedged to the confidence we actually hold: Decision 9 records this as a spot-check on
    // one account, explicitly not documented Gmail behaviour, so the copy must not read as
    // settled fact.
    expect(screen.getByText(/From what we have observed/)).toBeInTheDocument();
    expect(screen.getByText(/example\.com\.au \(1\)/)).toBeInTheDocument();
  });

  it("admits the match surface is not fully enumerable", () => {
    renderWith("parentDomain");

    // Observed senders are a floor, not the whole set — claiming otherwise would make the
    // list read as exhaustive when a domain nobody has written from cannot appear in it.
    // …and names WHICH unknown matters: new subdomains are the point of the rule, whereas a
    // same-prefix domain owned by someone else is the part worth weighing.
    expect(screen.getByText(/owned by someone else/)).toBeInTheDocument();
  });

  it("shows no breadth warning until the scope is actually selected", () => {
    renderWith("domain");
    expect(screen.queryByText(/NOT part of example\.com/)).not.toBeInTheDocument();
  });
});

describe("TrustActions — domain-scope breadth (#210)", () => {
  const sender = makeSender({ id: "s", email: "promo@monzo.com", domain: "monzo.com" });

  const coverage = {
    domain: "monzo.com",
    covered: [
      { domain: "monzo.com", senderCount: 2 },
      { domain: "ads.monzo.com", senderCount: 1 },
    ],
    carvedOut: [{ domain: "email.monzo.com", senderCount: 3 }],
    senderCount: 3,
  };

  function renderWith(scope: DecisionScope, domainCoverage = coverage) {
    render(
      <TrustActions
        sender={sender}
        scope={scope}
        onScopeChange={vi.fn()}
        canScopeDomain
        domainCoverage={domainCoverage}
        onDecide={vi.fn()}
      />,
    );
  }

  it("names the extra subdomains in the scope label, before anything is selected", () => {
    renderWith("address");

    // The label is where a "whole domain" decision is actually chosen, and it read as narrower
    // than it enforces. `*@monzo.com` spans the subtree, so the count belongs here, not only in
    // a panel the user sees after committing to the scope.
    expect(screen.getByLabelText(/Whole domain \(monzo\.com \+ 1 subdomain\)/)).toBeInTheDocument();
  });

  it("lists the subdomains the block would reach once the scope is selected", () => {
    renderWith("domain");

    expect(screen.getByText(/covers every sender at monzo\.com and below/)).toBeInTheDocument();
    expect(screen.getByText(/ads\.monzo\.com \(1\)/)).toBeInTheDocument();
  });

  it("says which subdomains stay decided rather than silently omitting them", () => {
    renderWith("domain");

    // A carve-out is the user's own earlier decision surviving. Leaving it off the list would
    // overstate the block; leaving it in the covered list would state the opposite of what
    // enforcement does.
    expect(screen.getByText(/you decided them separately/)).toBeInTheDocument();
    expect(screen.getByText(/email\.monzo\.com \(3\)/)).toBeInTheDocument();
  });

  it("admits the reach is not enumerable in advance", () => {
    renderWith("domain");

    // Observed subdomains are a floor. A subdomain that has not written yet is covered anyway,
    // which is exactly the leak #136 exists to close — so the copy must not read as a full list.
    expect(screen.getByText(/have not written yet/)).toBeInTheDocument();
  });

  it("shows no panel when nothing under the domain has been seen", () => {
    renderWith("domain", {
      domain: "shop.com",
      covered: [{ domain: "shop.com", senderCount: 2 }],
      carvedOut: [],
      senderCount: 2,
    });

    // Nothing observed below it means the panel would restate the label. The future-subdomain
    // caveat still applies, but a panel that says only that is noise on the commonest action.
    expect(screen.queryByText(/and below/)).not.toBeInTheDocument();
  });
});
