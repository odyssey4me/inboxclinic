// SPDX-License-Identifier: Apache-2.0
import { keyFor, type Prompt, type Store } from "@inboxclinic/core";
import {
  createInMemoryStore,
  domainBuilder,
  MockGmailClient,
  senderBuilder,
} from "@inboxclinic/core/testing";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import { Dashboard } from "./Dashboard";

function setup(): { store: Store; gmail: MockGmailClient } {
  return { store: createInMemoryStore(), gmail: new MockGmailClient() };
}

function renderDashboard(
  store: Store,
  gmail: MockGmailClient,
  overrides: Partial<ComponentProps<typeof Dashboard>> = {},
) {
  return render(
    <Dashboard
      store={store}
      gmail={gmail}
      online
      refreshKey={0}
      onStartWorkflow={vi.fn()}
      onChanged={vi.fn()}
      {...overrides}
    />,
  );
}

function promptFor(email: string): Prompt {
  return {
    id: `prompt:${email}`,
    senderId: keyFor(email),
    priorityScore: 1,
    components: { impact: 0, confidence: 0, batch: 0, alignment: 0 },
    batchGroupId: null,
    batchSize: 1,
    createdAt: 0,
    expiresAt: 0,
    resolvedAt: null,
    deferredAt: null,
  };
}

describe("Dashboard — decisions surface", () => {
  it("splits senders across Pending·Decided·All tabs with counts in the labels", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("pending@x.com"));
    await store.senders.put(senderBuilder("trusted@y.com", { trustStatus: "trusted" }));

    renderDashboard(store, gmail);

    // Default tab is Pending: shows the undecided sender, not the decided one.
    expect(await screen.findByText("pending@x.com")).toBeInTheDocument();
    expect(screen.queryByText("trusted@y.com")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /pending \(1\)/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /decided \(1\)/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /all \(2\)/i })).toBeInTheDocument();

    // Decided tab flips to the decided sender.
    fireEvent.click(screen.getByRole("tab", { name: /decided \(1\)/i }));
    expect(await screen.findByText("trusted@y.com")).toBeInTheDocument();
    expect(screen.queryByText("pending@x.com")).not.toBeInTheDocument();

    // All shows both.
    fireEvent.click(screen.getByRole("tab", { name: /all \(2\)/i }));
    expect(await screen.findByText("pending@x.com")).toBeInTheDocument();
    expect(screen.getByText("trusted@y.com")).toBeInTheDocument();
  });

  it("filters the visible senders by the search query", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("alpha@x.com"));
    await store.senders.put(senderBuilder("beta@y.com"));

    renderDashboard(store, gmail);
    await screen.findByText("alpha@x.com");
    expect(screen.getByText("beta@y.com")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: /search senders/i }), {
      target: { value: "alpha" },
    });

    expect(screen.getByText("alpha@x.com")).toBeInTheDocument();
    expect(screen.queryByText("beta@y.com")).not.toBeInTheDocument();
  });

  it("orders by email volume by default and re-sorts by name when its header is clicked", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("zeb@x.com", { totalEmails: 10 }));
    await store.senders.put(senderBuilder("amy@x.com", { totalEmails: 2 }));

    renderDashboard(store, gmail);
    await screen.findByText("zeb@x.com");

    // Default sort is volume descending → the high-volume sender is the first data row.
    const firstByVolume = screen.getAllByRole("row")[1]!;
    expect(within(firstByVolume).getByText("zeb@x.com")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Sender/ }));

    // Name ascending → "amy" now leads.
    const firstByName = screen.getAllByRole("row")[1]!;
    expect(within(firstByName).getByText("amy@x.com")).toBeInTheDocument();
  });

  it("applies an inline Trust immediately and refreshes", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("news@x.com"));
    const onChanged = vi.fn();

    renderDashboard(store, gmail, { onChanged });
    await screen.findByText("news@x.com");

    fireEvent.click(screen.getByRole("button", { name: "Trust" }));

    await waitFor(async () =>
      expect((await store.senders.get(keyFor("news@x.com")))?.trustStatus).toBe("trusted"),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("opens the detail panel (impact preview + confirm) for a Block, rather than acting inline", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("spam@x.com"));

    renderDashboard(store, gmail);
    await screen.findByText("spam@x.com");

    fireEvent.click(screen.getByRole("button", { name: "Block" }));

    // The sender detail drawer opens; no decision has been written yet.
    expect(
      await screen.findByRole("dialog", { name: /actions for spam@x.com/i }),
    ).toBeInTheDocument();
    expect((await store.senders.get(keyFor("spam@x.com")))?.trustStatus).toBe("pending");
  });

  it("opens the detail panel when a row is clicked", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("who@x.com"));

    renderDashboard(store, gmail);
    fireEvent.click(await screen.findByText("who@x.com"));

    expect(
      await screen.findByRole("dialog", { name: /actions for who@x.com/i }),
    ).toBeInTheDocument();
  });

  it("offers a Triage fast-path that launches the guided workflow when prompts are open", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("todo@x.com"));
    await store.prompts.put(promptFor("todo@x.com"));
    const onStartWorkflow = vi.fn();

    renderDashboard(store, gmail, { onStartWorkflow });

    const triage = await screen.findByRole("button", { name: /triage 1 pending/i });
    fireEvent.click(triage);
    expect(onStartWorkflow).toHaveBeenCalledOnce();
  });

  it("shows a scan prompt when there are no senders", async () => {
    const { store, gmail } = setup();
    renderDashboard(store, gmail);
    expect(
      await screen.findByText(/run a scan from settings to start triaging/i),
    ).toBeInTheDocument();
  });
});

describe("Dashboard — group by domain", () => {
  it("swaps senders for domain aggregates when the toggle is on", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("a@shop.com"));
    await store.senders.put(senderBuilder("b@shop.com"));
    await store.domains.put(domainBuilder("shop.com", { senderCount: 2, totalEmails: 9 }));

    renderDashboard(store, gmail);
    await screen.findByText("a@shop.com");

    fireEvent.click(await screen.findByRole("checkbox", { name: /group by domain/i }));

    // The domain aggregate replaces its individual senders, and search now targets domains.
    expect(await screen.findByText("shop.com")).toBeInTheDocument();
    expect(screen.queryByText("a@shop.com")).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: /search domains/i })).toBeInTheDocument();
  });

  it("tab counts reflect domains (not senders) when grouped", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("a@shop.com"));
    await store.domains.put(domainBuilder("shop.com"));
    await store.domains.put(domainBuilder("bank.com", { trustStatus: "trusted" }));

    renderDashboard(store, gmail);
    fireEvent.click(await screen.findByRole("checkbox", { name: /group by domain/i }));

    expect(await screen.findByRole("tab", { name: /pending \(1\)/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /decided \(1\)/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /all \(2\)/i })).toBeInTheDocument();
  });

  it("applies an inline domain Trust immediately at domain scope", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("a@shop.com"));
    await store.domains.put(domainBuilder("shop.com"));
    const onChanged = vi.fn();

    renderDashboard(store, gmail, { onChanged });
    fireEvent.click(await screen.findByRole("checkbox", { name: /group by domain/i }));
    await screen.findByText("shop.com");

    fireEvent.click(screen.getByRole("button", { name: "Trust" }));

    await waitFor(async () =>
      expect((await store.domains.get(keyFor("shop.com")))?.trustStatus).toBe("trusted"),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("routes an inline domain Block through the detail panel (no immediate write)", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("a@shop.com"));
    await store.domains.put(domainBuilder("shop.com"));

    renderDashboard(store, gmail);
    fireEvent.click(await screen.findByRole("checkbox", { name: /group by domain/i }));
    await screen.findByText("shop.com");

    fireEvent.click(screen.getByRole("button", { name: "Block" }));

    expect(
      await screen.findByRole("dialog", { name: /actions for shop\.com/i }),
    ).toBeInTheDocument();
    expect((await store.domains.get(keyFor("shop.com")))?.trustStatus).toBe("pending");
  });

  it("opens the domain detail panel with member drill-in on row click", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("a@shop.com"));
    await store.domains.put(domainBuilder("shop.com", { senderCount: 1 }));

    renderDashboard(store, gmail);
    fireEvent.click(await screen.findByRole("checkbox", { name: /group by domain/i }));
    fireEvent.click(await screen.findByText("shop.com"));

    const drawer = await screen.findByRole("dialog", { name: /actions for shop\.com/i });
    expect(within(drawer).getByText("a@shop.com")).toBeInTheDocument();
  });

  it("reflects a domain decision on the sender surface (effective status)", async () => {
    const { store, gmail } = setup();
    // The sender is undecided at the address level, but its domain is trusted domain-wide.
    await store.senders.put(senderBuilder("a@shop.com"));
    await store.domains.put(
      domainBuilder("shop.com", { trustStatus: "trusted", decisionScope: "domain" }),
    );

    renderDashboard(store, gmail);

    // Effectively trusted via the domain → counted as Decided, not Pending.
    expect(await screen.findByRole("tab", { name: /decided \(1\)/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /pending \(0\)/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /decided \(1\)/i }));
    expect(await screen.findByText("a@shop.com")).toBeInTheDocument();
    expect(screen.getByText("trusted")).toBeInTheDocument();
    // Already trusted → no inline Trust action on the sender row.
    expect(screen.queryByRole("button", { name: "Trust" })).not.toBeInTheDocument();
  });
});
