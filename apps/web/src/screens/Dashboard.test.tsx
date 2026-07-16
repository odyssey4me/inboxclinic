// SPDX-License-Identifier: Apache-2.0
import { keyFor, type Prompt, type Store } from "@inboxclinic/core";
import { createInMemoryStore, MockGmailClient, senderBuilder } from "@inboxclinic/core/testing";
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
