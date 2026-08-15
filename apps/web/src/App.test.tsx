// SPDX-License-Identifier: Apache-2.0
import { createDemoEnvironment, DEMO_ACCOUNT_EMAIL } from "@inboxclinic/core/demo";
import {
  createInMemoryStore,
  messageMetaBuilder,
  MockBackupClient,
  MockGmailClient,
} from "@inboxclinic/core/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

const DEMO_NOW = Date.UTC(2026, 6, 5);

// App now owns a BrowserRouter over jsdom's shared history, so reset the URL between tests
// (otherwise a test that navigated leaves the next one on the wrong route).
beforeEach(() => {
  window.history.pushState({}, "", "/");
});

function setup() {
  const gmail = new MockGmailClient(
    [
      messageMetaBuilder({ headers: { from: "Jane <jane@acme.test>" } }),
      messageMetaBuilder({
        headers: { from: "news@promo.test", listUnsubscribe: "<mailto:u@promo.test>" },
        labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
      }),
    ],
    "owner@example.com",
  );
  const store = createInMemoryStore();
  const backup = new MockBackupClient();
  return { gmail, store, backup };
}

describe("App", () => {
  it("renders the product name and tagline", () => {
    const { gmail, store, backup } = setup();
    render(<App gmail={gmail} store={store} backup={backup} />);

    expect(screen.getByRole("heading", { name: /inbox clinic/i })).toBeInTheDocument();
    expect(screen.getByText(/take back control of your inbox/i)).toBeInTheDocument();
  });

  it("offers sign-in and a request-access link before authentication", () => {
    const { gmail, store, backup } = setup();
    render(<App gmail={gmail} store={store} backup={backup} />);

    expect(screen.getByRole("button", { name: /sign in with google/i })).toBeInTheDocument();
    const requestAccess = screen.getByRole("link", { name: /request access/i });
    // Falls back to the repo issues page when VITE_REQUEST_ACCESS_URL is unset (as in CI).
    expect(requestAccess).toHaveAttribute("href", expect.stringContaining("http"));
  });

  it("shows the funding/source footer", () => {
    const { gmail, store, backup } = setup();
    render(<App gmail={gmail} store={store} backup={backup} />);

    expect(screen.getByRole("link", { name: /sponsor/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /source/i })).toBeInTheDocument();
  });

  it("syncs on open: populates senders right after sign-in, no scan click (mock only)", async () => {
    const { gmail, store, backup } = setup();
    render(<App gmail={gmail} store={store} backup={backup} />);

    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));

    // sync-on-open runs incrementalSync (full scan on first run) without a manual click.
    expect((await screen.findAllByText("jane@acme.test")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("news@promo.test")).length).toBeGreaterThan(0);

    // The History-API marker is seeded so subsequent syncs are incremental.
    const profile = await store.profile.get();
    expect(profile?.lastHistoryId).not.toBeNull();
  });

  it("reseeds the History-API marker after a Full rescan, so the next sync stays incremental (issue #47)", async () => {
    const { gmail, store, backup } = setup();
    render(<App gmail={gmail} store={store} backup={backup} />);

    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    // The email appears twice — the sidebar-foot account menu's closed summary and its
    // (unopened) panel — so match all rather than assuming a single node.
    await screen.findAllByText("owner@example.com");
    const seededHistoryId = (await store.profile.get())?.lastHistoryId;
    expect(seededHistoryId).not.toBeNull();

    // The mailbox moves on before the user triggers a "Full rescan" from Settings.
    gmail.setLatestHistoryId("999");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: /rescan inbox/i }));

    await screen.findByText(/rescanned \d+ sender/i);
    const profile = await store.profile.get();
    // A stale marker here would make the next incrementalSync replay old history and
    // double-count sender totals — the rescan must reseed it to the mailbox's current
    // historyId, not leave it at the pre-rescan value.
    expect(profile?.lastHistoryId).toBe("999");
  });

  it("demo mode renders a populated dashboard, the demo banner, and an exit", async () => {
    const { gmail, store, backup } = await createDemoEnvironment({ now: DEMO_NOW });
    render(
      <App gmail={gmail} store={store} backup={backup} demo initialEmail={DEMO_ACCOUNT_EMAIL} />,
    );

    // Signed-in as the demo identity, with a clearly-labelled demo banner + exit. The
    // email appears twice (account menu summary + panel), so match all.
    expect((await screen.findAllByText(DEMO_ACCOUNT_EMAIL)).length).toBeGreaterThan(0);
    expect(screen.getByText(/demo mode/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /exit demo/i })).toBeInTheDocument();

    // The dashboard is populated from the seeded store (no sign-in, no network). The
    // decisions surface defaults to the Pending tab; switch to All to see decided senders
    // (jane is seeded trusted, deals blocked).
    fireEvent.click(await screen.findByRole("tab", { name: /^all \(/i }));
    expect((await screen.findAllByText("jane.cooper@example.com")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("deals@retailco.test")).length).toBeGreaterThan(0);
  });

  it("signing out returns to the landing, revokes the grant, and is remembered", async () => {
    localStorage.clear();
    const onSignOut = vi.fn();
    const { gmail, store, backup } = setup();
    render(<App gmail={gmail} store={store} backup={backup} onSignOut={onSignOut} />);

    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    await screen.findAllByText("owner@example.com");

    // Sign out lives inside the sidebar-foot account menu; open it first.
    fireEvent.click(screen.getAllByText("owner@example.com")[0]!.closest("summary")!);
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));

    expect(screen.getByRole("button", { name: /sign in with google/i })).toBeInTheDocument();
    expect(localStorage.getItem("inboxclinic.signedOut")).toBe("1");
    // The grant is revoked, not just forgotten — see design-gmail-integration.md D1.
    expect(onSignOut).toHaveBeenCalledOnce();
    localStorage.clear();
  });

  it("pins the mobile layout from the switch and remembers it on-device", async () => {
    localStorage.clear();
    const { gmail, store, backup } = setup();
    render(<App gmail={gmail} store={store} backup={backup} />);

    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    await screen.findAllByText("owner@example.com");

    // With no matchMedia (jsdom), Auto resolves to the desktop shell — a sidebar.
    expect(screen.getByRole("complementary")).toBeInTheDocument();

    // The layout switch lives inside the sidebar-foot account menu; open it first.
    fireEvent.click(screen.getAllByText("owner@example.com")[0]!.closest("summary")!);

    // Pinning Mobile swaps to the single-column shell (no sidebar) and is persisted.
    fireEvent.click(screen.getByRole("button", { name: "Mobile" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(localStorage.getItem("inboxclinic.layoutPref")).toBe("mobile");
    localStorage.clear();
  });

  it("lists senders with their category after sign-in (mock only)", async () => {
    const { gmail, store, backup } = setup();
    render(<App gmail={gmail} store={store} backup={backup} />);

    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));

    // The email appears twice (account menu summary + panel), so match all.
    expect((await screen.findAllByText("owner@example.com")).length).toBeGreaterThan(0);

    // sync-on-open populates the senders table (no manual scan needed).
    expect((await screen.findAllByText("jane@acme.test")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("news@promo.test")).length).toBeGreaterThan(0);
    // The promotional sender is categorised from its CATEGORY_PROMOTIONS label.
    expect(screen.getByText("promotional")).toBeInTheDocument();

    // Refresh replaces the old Sync/Scan pair.
    expect(screen.getByRole("button", { name: /^refresh$/i })).toBeInTheDocument();
  });

  it("navigating updates the URL (history routing)", async () => {
    const { gmail, store, backup } = await createDemoEnvironment({ now: DEMO_NOW });
    render(
      <App gmail={gmail} store={store} backup={backup} demo initialEmail={DEMO_ACCOUNT_EMAIL} />,
    );
    await screen.findAllByText(DEMO_ACCOUNT_EMAIL);
    expect(window.location.pathname).toBe("/");

    fireEvent.click(screen.getByRole("button", { name: "Analytics" }));
    await waitFor(() => expect(window.location.pathname).toBe("/analytics"));
  });

  it("a deep link renders the target screen directly", async () => {
    window.history.pushState({}, "", "/settings");
    const { gmail, store, backup } = await createDemoEnvironment({ now: DEMO_NOW });
    render(
      <App gmail={gmail} store={store} backup={backup} demo initialEmail={DEMO_ACCOUNT_EMAIL} />,
    );

    // Settings renders straight from the URL (no in-app navigation needed).
    expect(await screen.findByRole("button", { name: /rescan inbox/i })).toBeInTheDocument();
  });

  it("the back button returns to the previous view", async () => {
    const { gmail, store, backup } = await createDemoEnvironment({ now: DEMO_NOW });
    render(
      <App gmail={gmail} store={store} backup={backup} demo initialEmail={DEMO_ACCOUNT_EMAIL} />,
    );
    await screen.findAllByText(DEMO_ACCOUNT_EMAIL);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(window.location.pathname).toBe("/settings"));
    await screen.findByRole("button", { name: /rescan inbox/i });

    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe("/"));
  });

  it("an unknown deep link falls back to the home surface", async () => {
    window.history.pushState({}, "", "/does-not-exist");
    const { gmail, store, backup } = await createDemoEnvironment({ now: DEMO_NOW });
    render(
      <App gmail={gmail} store={store} backup={backup} demo initialEmail={DEMO_ACCOUNT_EMAIL} />,
    );
    await screen.findAllByText(DEMO_ACCOUNT_EMAIL);
    await waitFor(() => expect(window.location.pathname).toBe("/"));
  });
});
