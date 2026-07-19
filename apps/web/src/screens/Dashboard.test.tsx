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
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { LayoutContext } from "../layout/context";
import { Dashboard } from "./Dashboard";

/** Renders the current URL search string so tests can assert URL-controlled state (#120). */
function LocationProbe() {
  const { search } = useLocation();
  return <div data-testid="location-search" data-search={search} />;
}

const currentSearch = (): string =>
  screen.getByTestId("location-search").getAttribute("data-search") ?? "";

/** Render pinned to the mobile shell (jsdom otherwise resolves layout to desktop). */
function renderMobile(
  store: Store,
  gmail: MockGmailClient,
  overrides: Partial<ComponentProps<typeof Dashboard>> = {},
  initialEntries: string[] = ["/"],
) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <LocationProbe />
      <LayoutContext.Provider value={{ pref: "mobile", setPref: vi.fn(), layout: "mobile" }}>
        <Dashboard
          store={store}
          gmail={gmail}
          online
          refreshKey={0}
          onStartWorkflow={vi.fn()}
          onChanged={vi.fn()}
          {...overrides}
        />
      </LayoutContext.Provider>
    </MemoryRouter>,
  );
}

function setup(): { store: Store; gmail: MockGmailClient } {
  return { store: createInMemoryStore(), gmail: new MockGmailClient() };
}

function renderDashboard(
  store: Store,
  gmail: MockGmailClient,
  overrides: Partial<ComponentProps<typeof Dashboard>> = {},
  initialEntries: string[] = ["/"],
) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <LocationProbe />
      <Dashboard
        store={store}
        gmail={gmail}
        online
        refreshKey={0}
        onStartWorkflow={vi.fn()}
        onChanged={vi.fn()}
        {...overrides}
      />
    </MemoryRouter>,
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

describe("Dashboard — mobile wizard-forward", () => {
  it("leads with a prominent Triage CTA on mobile and launches the workflow", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("todo@x.com"));
    await store.prompts.put(promptFor("todo@x.com"));
    const onStartWorkflow = vi.fn();

    renderMobile(store, gmail, { onStartWorkflow });

    // The prominent CTA carries the wizard framing (not just a compact header button).
    const cta = await screen.findByRole("button", { name: /triage 1 pending/i });
    expect(cta).toHaveTextContent(/quickest way on a phone/i);

    fireEvent.click(cta);
    expect(onStartWorkflow).toHaveBeenCalledOnce();
  });

  it("shows no Triage CTA when nothing is pending", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("done@x.com", { trustStatus: "trusted" }));

    renderMobile(store, gmail);
    await screen.findByRole("tab", { name: /all \(1\)/i });
    expect(screen.queryByRole("button", { name: /triage \d+ pending/i })).not.toBeInTheDocument();
  });
});

describe("Dashboard — flagged siblings (#96)", () => {
  it("surfaces flagged same-domain siblings in the detail panel", async () => {
    const { store, gmail } = setup();
    // spamMarkedCount is a prior-block signal the learn pass doesn't overwrite.
    await store.senders.put(senderBuilder("a@shop.com", { spamMarkedCount: 1 }));
    await store.senders.put(senderBuilder("b@shop.com", { spamMarkedCount: 2 }));

    renderDashboard(store, gmail);
    fireEvent.click(await screen.findByText("a@shop.com"));

    const drawer = await screen.findByRole("dialog", { name: /actions for a@shop.com/i });
    expect(await within(drawer).findByText(/1 other flagged sender/i)).toBeInTheDocument();
  });
});

describe("Dashboard — URL-controlled tab + detail (#120)", () => {
  it("puts the active tab in the URL, preserving ?demo=1; default pending stays clean", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("pending@x.com"));
    await store.senders.put(senderBuilder("trusted@y.com", { trustStatus: "trusted" }));

    renderDashboard(store, gmail, {}, ["/?demo=1"]);
    await screen.findByText("pending@x.com");
    expect(currentSearch()).toBe("?demo=1"); // default tab omitted from the URL

    fireEvent.click(screen.getByRole("tab", { name: /decided \(1\)/i }));
    await screen.findByText("trusted@y.com");
    const params = new URLSearchParams(currentSearch());
    expect(params.get("tab")).toBe("decided");
    expect(params.get("demo")).toBe("1"); // ?demo=1 survives the merge
  });

  it("opens the tab named in ?tab= on load", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("pending@x.com"));
    await store.senders.put(senderBuilder("trusted@y.com", { trustStatus: "trusted" }));

    renderDashboard(store, gmail, {}, ["/?tab=decided"]);
    expect(await screen.findByText("trusted@y.com")).toBeInTheDocument();
    expect(screen.queryByText("pending@x.com")).not.toBeInTheDocument();
  });

  it("opens the detail panel for ?sender=<id> on load and clears the param on close", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("deep@x.com"));

    renderDashboard(store, gmail, {}, [`/?sender=${keyFor("deep@x.com")}`]);
    expect(
      await screen.findByRole("dialog", { name: /actions for deep@x.com/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    await waitFor(() => expect(new URLSearchParams(currentSearch()).has("sender")).toBe(false));
  });

  it("clicking a row puts ?sender=<id> in the URL", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("row@x.com"));

    renderDashboard(store, gmail);
    fireEvent.click(await screen.findByText("row@x.com"));
    await waitFor(() =>
      expect(new URLSearchParams(currentSearch()).get("sender")).toBe(keyFor("row@x.com")),
    );
  });

  it("opens only the sender detail when both ?sender= and ?domain= are present", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("s@shop.com"));
    await store.domains.put(domainBuilder("shop.com"));

    renderDashboard(store, gmail, {}, [
      `/?sender=${keyFor("s@shop.com")}&domain=${keyFor("shop.com")}`,
    ]);

    expect(
      await screen.findByRole("dialog", { name: /actions for s@shop\.com/i }),
    ).toBeInTheDocument();
    // Exactly one drawer — the domain detail ("actions for shop.com") must not also open.
    expect(
      screen.queryByRole("dialog", { name: /^actions for shop\.com/i }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("ignores an unknown ?sender= id (panel stays closed)", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("real@x.com"));

    renderDashboard(store, gmail, {}, ["/?sender=does-not-exist"]);
    await screen.findByText("real@x.com");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
