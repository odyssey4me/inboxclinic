import {
  createInMemoryStore,
  messageMetaBuilder,
  MockGmailClient,
} from "@inboxclinic/core/testing";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";

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
  return { gmail, store };
}

describe("App", () => {
  it("renders the product name and tagline", () => {
    const { gmail, store } = setup();
    render(<App gmail={gmail} store={store} />);

    expect(screen.getByRole("heading", { name: /inbox clinic/i })).toBeInTheDocument();
    expect(screen.getByText(/take back control of your inbox/i)).toBeInTheDocument();
  });

  it("offers sign-in and a request-access link before authentication", () => {
    const { gmail, store } = setup();
    render(<App gmail={gmail} store={store} />);

    expect(screen.getByRole("button", { name: /sign in with google/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /request access/i })).toBeInTheDocument();
  });

  it("syncs on open: populates senders right after sign-in, no scan click (mock only)", async () => {
    const { gmail, store } = setup();
    render(<App gmail={gmail} store={store} />);

    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));

    // sync-on-open runs incrementalSync (full scan on first run) without a manual click.
    expect((await screen.findAllByText("jane@acme.com")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("news@promo.com")).length).toBeGreaterThan(0);

    // The History-API marker is seeded so subsequent syncs are incremental.
    const profile = await store.profile.get();
    expect(profile?.lastHistoryId).not.toBeNull();
  });

  it("lists scanned senders after sign-in and scan (no real Google)", async () => {
    const { gmail, store } = setup();
    render(<App gmail={gmail} store={store} />);

    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));

    const scanButton = await screen.findByRole("button", { name: /scan inbox/i });
    expect(await screen.findByText("owner@gmail.com")).toBeInTheDocument();

    fireEvent.click(scanButton);

    // Senders surface both in the pending list and the senders table.
    expect((await screen.findAllByText("jane@acme.com")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("news@promo.com")).length).toBeGreaterThan(0);
    // The promotional sender is categorised from its CATEGORY_PROMOTIONS label.
    expect(screen.getByText("promotional")).toBeInTheDocument();
  });
});
