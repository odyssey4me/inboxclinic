// SPDX-License-Identifier: Apache-2.0
import { createDemoEnvironment, DEMO_ACCOUNT_EMAIL } from "@inboxclinic/core/demo";
import {
  createInMemoryStore,
  messageMetaBuilder,
  MockBackupClient,
  MockGmailClient,
} from "@inboxclinic/core/testing";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";

const DEMO_NOW = Date.UTC(2026, 6, 5);

function setup() {
  const gmail = new MockGmailClient(
    [
      messageMetaBuilder({ headers: { from: "Jane <jane@acme.com>" } }),
      messageMetaBuilder({
        headers: { from: "news@promo.com", listUnsubscribe: "<mailto:u@promo.com>" },
        labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
      }),
    ],
    "owner@gmail.com",
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
    expect((await screen.findAllByText("jane@acme.com")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("news@promo.com")).length).toBeGreaterThan(0);

    // The History-API marker is seeded so subsequent syncs are incremental.
    const profile = await store.profile.get();
    expect(profile?.lastHistoryId).not.toBeNull();
  });

  it("demo mode renders a populated dashboard, the demo banner, and an exit", async () => {
    const { gmail, store, backup } = await createDemoEnvironment({ now: DEMO_NOW });
    render(
      <App gmail={gmail} store={store} backup={backup} demo initialEmail={DEMO_ACCOUNT_EMAIL} />,
    );

    // Signed-in as the demo identity, with a clearly-labelled demo banner + exit.
    expect(await screen.findByText(DEMO_ACCOUNT_EMAIL)).toBeInTheDocument();
    expect(screen.getByText(/demo mode/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /exit demo/i })).toBeInTheDocument();

    // The dashboard is populated from the seeded store (no sign-in, no network).
    expect((await screen.findAllByText("jane.cooper@gmail.com")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("deals@retailco.com")).length).toBeGreaterThan(0);
  });

  it("disconnect returns to the signed-out landing and is remembered", async () => {
    localStorage.clear();
    const { gmail, store, backup } = setup();
    render(<App gmail={gmail} store={store} backup={backup} />);

    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    await screen.findByText("owner@gmail.com");

    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));

    expect(screen.getByRole("button", { name: /sign in with google/i })).toBeInTheDocument();
    expect(localStorage.getItem("inboxclinic.signedOut")).toBe("1");
    localStorage.clear();
  });

  it("pins the mobile layout from the switch and remembers it on-device", async () => {
    localStorage.clear();
    const { gmail, store, backup } = setup();
    render(<App gmail={gmail} store={store} backup={backup} />);

    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    await screen.findByText("owner@gmail.com");

    // With no matchMedia (jsdom), Auto resolves to the desktop shell — a sidebar.
    expect(screen.getByRole("complementary")).toBeInTheDocument();

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

    expect(await screen.findByText("owner@gmail.com")).toBeInTheDocument();

    // sync-on-open populates the senders table (no manual scan needed).
    expect((await screen.findAllByText("jane@acme.com")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("news@promo.com")).length).toBeGreaterThan(0);
    // The promotional sender is categorised from its CATEGORY_PROMOTIONS label.
    expect(screen.getByText("promotional")).toBeInTheDocument();

    // Refresh replaces the old Sync/Scan pair.
    expect(screen.getByRole("button", { name: /^refresh$/i })).toBeInTheDocument();
  });
});
