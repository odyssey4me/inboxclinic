// SPDX-License-Identifier: Apache-2.0
import { keyFor, type Domain } from "@inboxclinic/core";
import { createInMemoryStore, MockGmailClient } from "@inboxclinic/core/testing";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DomainDetail } from "./DomainDetail";

// The panel that answers "why is this blocked when I never decided it?". The breadth of a
// whole-subtree rule is stated once, when the rule is made; afterwards this is the only place
// that says a rule exists at all (design-trust-decisions.md Decision 9).

function domainFixture(name: string, overrides: Partial<Domain> = {}): Domain {
  return {
    id: keyFor(name),
    domain: name,
    trustStatus: "pending",
    senderCount: 1,
    totalEmails: 3,
    exceptionAddresses: [],
    exceptionDomains: [],
    updatedAt: 0,
    trustDecidedAt: null,
    decisionScope: null,
    decisionContext: null,
    pendingActions: [],
    ...overrides,
  };
}

const parentRule = (overrides: Partial<Domain> = {}): Domain =>
  domainFixture("example.com", {
    trustStatus: "blocked",
    decisionScope: "parentDomain",
    ...overrides,
  });

function renderPanel(domain: Domain, allDomains: Domain[]) {
  render(
    <DomainDetail
      domain={domain}
      members={[]}
      allDomains={allDomains}
      store={createInMemoryStore()}
      gmail={new MockGmailClient()}
      online={false}
      onClose={vi.fn()}
      onOpenSender={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
}

describe("DomainDetail — governed by a parent rule (#186)", () => {
  it("names the rule deciding a domain nobody decided directly", () => {
    const subdomain = domainFixture("news.example.com");
    renderPanel(subdomain, [parentRule(), subdomain]);

    expect(screen.getByText(/Blocked by the rule on example\.com/)).toBeInTheDocument();
    expect(
      screen.getByText(/No decision was made about news\.example\.com on its own/),
    ).toBeInTheDocument();
  });

  it("offers the opposite decision as a one-click carve-out", () => {
    const subdomain = domainFixture("news.example.com");
    renderPanel(subdomain, [parentRule(), subdomain]);

    // Under a blocked rule the useful action is keeping this one, not blocking it again.
    expect(screen.getByRole("button", { name: "Keep this one" })).toBeInTheDocument();
  });

  it("inverts the offer under a trusting rule", () => {
    const subdomain = domainFixture("news.example.com");
    renderPanel(subdomain, [parentRule({ trustStatus: "trusted" }), subdomain]);

    expect(screen.getByText(/Trusted by the rule on example\.com/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Block this one" })).toBeInTheDocument();
  });

  it("says so when the domain is already carved out, and offers nothing further", () => {
    const subdomain = domainFixture("news.example.com", {
      trustStatus: "trusted",
      decisionScope: "domain",
    });
    renderPanel(subdomain, [parentRule({ exceptionDomains: ["news.example.com"] }), subdomain]);

    expect(screen.getByText(/Carved out of the rule on example\.com/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Keep this one" })).not.toBeInTheDocument();
  });

  it("stays silent when no rule governs the domain", () => {
    const standalone = domainFixture("news.example.com");
    // The parent record exists but carries no decision — nothing to explain.
    renderPanel(standalone, [domainFixture("example.com"), standalone]);

    expect(screen.queryByText(/by the rule on/)).not.toBeInTheDocument();
  });

  it("stays silent for a domain that IS its own registrable domain", () => {
    // `example.com`'s rule lives on its own record, so there is no rule "from above" to
    // explain — saying otherwise would describe its own decision back to the user.
    const apex = parentRule();
    renderPanel(apex, [apex]);

    expect(screen.queryByText(/by the rule on/)).not.toBeInTheDocument();
  });
});
