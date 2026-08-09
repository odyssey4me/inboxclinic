// SPDX-License-Identifier: Apache-2.0
import { keyFor, type Store } from "@inboxclinic/core";
import {
  createInMemoryStore,
  domainBuilder,
  MockGmailClient,
  senderBuilder,
} from "@inboxclinic/core/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SenderDetail } from "./SenderDetail";

function setup(): { store: Store; gmail: MockGmailClient } {
  return { store: createInMemoryStore(), gmail: new MockGmailClient() };
}

describe("SenderDetail — flagged siblings (#96)", () => {
  it("offers to block all flagged same-domain siblings together, previewed and confirmed", async () => {
    const { store, gmail } = setup();
    const a = senderBuilder("a@shop.com", { spamMarkedCount: 1 });
    const b = senderBuilder("b@shop.com", { coveredByBlockFilter: true });
    await store.senders.put(a);
    await store.senders.put(b);
    const onChanged = vi.fn();
    const onClose = vi.fn();

    render(
      <SenderDetail
        sender={a}
        flaggedSiblings={[b]}
        store={store}
        gmail={gmail}
        online
        onClose={onClose}
        onChanged={onChanged}
      />,
    );

    // The offer surfaces the flagged sibling; blocking previews impact before applying.
    expect(screen.getByText(/1 other flagged sender/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /block all 2/i }));

    fireEvent.click(await screen.findByRole("button", { name: /confirm block all/i }));

    await waitFor(async () => {
      expect((await store.senders.get(keyFor("a@shop.com")))?.trustStatus).toBe("blocked");
      expect((await store.senders.get(keyFor("b@shop.com")))?.trustStatus).toBe("blocked");
    });
    expect(onChanged).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps all flagged siblings (trust) in one step", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("a@shop.com", { spamMarkedCount: 1 }));
    await store.senders.put(senderBuilder("b@shop.com", { coveredByBlockFilter: true }));

    render(
      <SenderDetail
        sender={senderBuilder("a@shop.com", { spamMarkedCount: 1 })}
        flaggedSiblings={[senderBuilder("b@shop.com", { coveredByBlockFilter: true })]}
        store={store}
        gmail={gmail}
        online
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /keep all/i }));

    await waitFor(async () => {
      expect((await store.senders.get(keyFor("a@shop.com")))?.trustStatus).toBe("trusted");
      expect((await store.senders.get(keyFor("b@shop.com")))?.trustStatus).toBe("trusted");
    });
  });

  it("shows no flagged-siblings offer when there are none", () => {
    const { store, gmail } = setup();
    render(
      <SenderDetail
        sender={senderBuilder("solo@x.com")}
        store={store}
        gmail={gmail}
        online
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.queryByText(/other flagged sender/i)).not.toBeInTheDocument();
    // The normal single-sender actions still render.
    expect(screen.getByRole("button", { name: /^Trust$/ })).toBeInTheDocument();
  });
});

describe("SenderDetail — the rule governing a sender (#229)", () => {
  it("names the domain rule deciding a sender that was never decided itself", () => {
    const { store, gmail } = setup();
    render(
      <SenderDetail
        sender={senderBuilder("news@shop.com")}
        allDomains={[
          domainBuilder("shop.com", { trustStatus: "blocked", decisionScope: "domain" }),
        ]}
        store={store}
        gmail={gmail}
        online
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    // Without this the sender reads as blocked by nobody — the gap #186 closed for domains.
    expect(screen.getByText(/Blocked by the rule on/i)).toBeInTheDocument();
    expect(screen.getByText(/no decision was made about this address on its own/i)).toBeVisible();
  });

  it("states the breadth of a subtree rule reaching down from the registrable domain", () => {
    const { store, gmail } = setup();
    render(
      <SenderDetail
        sender={senderBuilder("a@news.example.com")}
        allDomains={[
          domainBuilder("example.com", { trustStatus: "blocked", decisionScope: "parentDomain" }),
        ]}
        store={store}
        gmail={gmail}
        online
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    // The breadth was stated once, when the rule was made; a sender under it has to be told too.
    expect(screen.getByText(/covers every domain beneath it/i)).toBeInTheDocument();
  });

  it("says so when the rule overrides a decision made before it existed", () => {
    const { store, gmail } = setup();
    render(
      <SenderDetail
        // Trusted earlier, and NOT a recorded exception — so the later domain block wins.
        sender={senderBuilder("old@shop.com", { trustStatus: "trusted", decisionScope: "address" })}
        allDomains={[
          domainBuilder("shop.com", { trustStatus: "blocked", decisionScope: "domain" }),
        ]}
        store={store}
        gmail={gmail}
        online
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByText(/overrides the earlier decision on this address/i)).toBeInTheDocument();
  });

  it("offers a carved-out sender the way back, clearing the decision and the carve-out", async () => {
    const { store, gmail } = setup();
    const sender = senderBuilder("vip@shop.com", {
      trustStatus: "trusted",
      decisionScope: "address",
    });
    await store.senders.put(sender);
    await store.domains.put(
      domainBuilder("shop.com", {
        trustStatus: "blocked",
        decisionScope: "domain",
        exceptionAddresses: ["vip@shop.com"],
      }),
    );

    render(
      <SenderDetail
        sender={sender}
        allDomains={[
          domainBuilder("shop.com", {
            trustStatus: "blocked",
            decisionScope: "domain",
            exceptionAddresses: ["vip@shop.com"],
          }),
        ]}
        store={store}
        gmail={gmail}
        online
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByText(/Carved out of the rule on/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /follow the rule again/i }));

    // Both halves, or the model and the behaviour diverge: the decision goes, and so does the
    // carve-out that told the rule to skip this address.
    await waitFor(async () => {
      expect((await store.senders.get(keyFor("vip@shop.com")))?.trustStatus).toBe("pending");
      expect((await store.domains.get(keyFor("shop.com")))?.exceptionAddresses).toEqual([]);
    });
  });

  it("names the subtree rule, not the subdomain's own, when the subdomain was decided first", () => {
    const { store, gmail } = setup();
    render(
      <SenderDetail
        sender={senderBuilder("a@news.example.com")}
        allDomains={[
          // Decided at domain scope BEFORE the subtree rule existed, so it was never added to
          // example.com's exceptionDomains — nothing carves out retroactively.
          domainBuilder("news.example.com", {
            trustStatus: "trusted",
            decisionScope: "domain",
          }),
          domainBuilder("example.com", { trustStatus: "blocked", decisionScope: "parentDomain" }),
        ]}
        store={store}
        gmail={gmail}
        online
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    // resolveEffectiveDecision applies the broadest un-excepted rule, so this sender is blocked.
    // Naming news.example.com would state the opposite verdict to the status badge beside it.
    expect(screen.getByText(/Blocked by the rule on/i)).toBeInTheDocument();
    expect(screen.getByText("example.com")).toBeInTheDocument();
    expect(screen.queryByText("news.example.com")).not.toBeInTheDocument();
  });

  it("prefers the subdomain's own rule once it is carved out of the subtree rule", () => {
    const { store, gmail } = setup();
    render(
      <SenderDetail
        sender={senderBuilder("a@news.example.com")}
        allDomains={[
          domainBuilder("news.example.com", { trustStatus: "trusted", decisionScope: "domain" }),
          // The carve-out the parent records when the subdomain is decided under it.
          domainBuilder("example.com", {
            trustStatus: "blocked",
            decisionScope: "parentDomain",
            exceptionDomains: ["news.example.com"],
          }),
        ]}
        store={store}
        gmail={gmail}
        online
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    // The parent steps aside for an excepted subdomain, so the exact rule is the one in force.
    expect(screen.getByText(/Trusted by the rule on/i)).toBeInTheDocument();
    expect(screen.getByText("news.example.com")).toBeInTheDocument();
  });

  it("says nothing when no rule governs the sender", () => {
    const { store, gmail } = setup();
    render(
      <SenderDetail
        // A domain record exists, but carries no decision — there is no rule to explain.
        sender={senderBuilder("solo@x.com")}
        allDomains={[domainBuilder("x.com")]}
        store={store}
        gmail={gmail}
        online
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.queryByText(/by the rule on/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /follow the rule again/i }),
    ).not.toBeInTheDocument();
  });
});
