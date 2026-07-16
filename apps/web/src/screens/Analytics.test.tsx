// SPDX-License-Identifier: Apache-2.0
import { recordDailyAnalytics, type Store } from "@inboxclinic/core";
import { createInMemoryStore, senderBuilder, domainBuilder } from "@inboxclinic/core/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Analytics } from "./Analytics";

const NOW = Date.now();

/** Seed an in-memory store with senders, domains, and a day's analytics counters. */
async function seeded(): Promise<Store> {
  const store = createInMemoryStore();
  await store.senders.bulkPut([
    senderBuilder("a@trusted.com", { trustStatus: "trusted", readRate: 1, category: "personal" }),
    senderBuilder("b@spam.com", {
      trustStatus: "blocked",
      readRate: 0,
      category: "promotional",
      totalEmails: 12,
    }),
  ]);
  await store.domains.bulkPut([
    domainBuilder("spam.com", { trustStatus: "blocked", totalEmails: 12 }),
    domainBuilder("trusted.com", { trustStatus: "trusted", totalEmails: 4 }),
  ]);
  await recordDailyAnalytics(store, NOW, {
    decisionsMade: 2,
    sendersBlocked: 1,
    sendersTrusted: 1,
    emailsBlocked: 60,
  });
  return store;
}

describe("Analytics view", () => {
  it("renders the inbox health score, the 30-day summary, and achievements", async () => {
    const store = await seeded();
    render(<Analytics store={store} />);

    expect(await screen.findByText("Inbox health")).toBeInTheDocument();
    // Health card shows a 0–100 score.
    expect(screen.getByText("/ 100")).toBeInTheDocument();
    // 30-day summary surfaces the recorded counters.
    expect(screen.getByText("Emails blocked")).toBeInTheDocument();
    expect(screen.getByText("Top blocked domains")).toBeInTheDocument();
    expect(screen.getAllByText("spam.com").length).toBeGreaterThan(0);
    // The first block earns an achievement badge.
    expect(screen.getByText(/First Block/)).toBeInTheDocument();
  });

  it("persists the monthly rollup when it loads", async () => {
    const store = await seeded();
    render(<Analytics store={store} />);

    await screen.findByText("Inbox health");
    await waitFor(async () => {
      const months = await store.analytics.recentDays(1);
      expect(months.length).toBeGreaterThan(0);
    });
    const month = new Date(NOW).toISOString().slice(0, 7);
    expect(await store.analytics.month(month)).toBeDefined();
  });

  it("copies a privacy-safe text summary to the clipboard (no network)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    const store = await seeded();
    render(<Analytics store={store} />);

    fireEvent.click(await screen.findByRole("button", { name: /copy text summary/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0]?.[0]).toContain("Inbox health:");

    vi.unstubAllGlobals();
  });

  it("offers the PNG snapshot image as the primary share action", async () => {
    const store = await seeded();
    render(<Analytics store={store} />);

    expect(
      await screen.findByRole("button", { name: /download image \(png\)/i }),
    ).toBeInTheDocument();
  });

  it("falls back to a status message when the browser can't render the snapshot image", async () => {
    // jsdom has no canvas backend, so rendering fails just like it would in a browser
    // without canvas support — the button must degrade gracefully, not throw.
    const store = await seeded();
    render(<Analytics store={store} />);

    fireEvent.click(await screen.findByRole("button", { name: /download image \(png\)/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      /couldn't render the snapshot image/i,
    );
  });
});
