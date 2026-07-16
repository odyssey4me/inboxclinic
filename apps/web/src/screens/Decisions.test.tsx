// SPDX-License-Identifier: Apache-2.0
import { keyFor, type Store } from "@inboxclinic/core";
import {
  createInMemoryStore,
  domainBuilder,
  inboxFromSender,
  messageMetaBuilder,
  MockGmailClient,
  senderBuilder,
} from "@inboxclinic/core/testing";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Decisions } from "./Decisions";

function setup(): { store: Store; gmail: MockGmailClient } {
  return { store: createInMemoryStore(), gmail: new MockGmailClient() };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("Decisions view", () => {
  it("shows an empty state when nothing has been decided yet", async () => {
    const { store, gmail } = setup();
    render(<Decisions store={store} gmail={gmail} online onChanged={vi.fn()} />);

    expect(
      await screen.findByText(/no decisions yet — triage some senders from the dashboard/i),
    ).toBeInTheDocument();
  });

  it("blocks a trusted sender: previews the impact, applies it, and reconciles a Gmail filter", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("a@x.com", { trustStatus: "trusted" }));
    gmail.seedInbox(inboxFromSender("a@x.com", 3));
    const onChanged = vi.fn();

    render(<Decisions store={store} gmail={gmail} online onChanged={onChanged} />);

    fireEvent.click(await screen.findByRole("button", { name: /change to block/i }));
    expect(screen.getByRole("alertdialog", { name: /confirm decision change/i })).toHaveTextContent(
      "a@x.com",
    );
    expect(await screen.findByText(/archive 3 existing emails/i)).toBeInTheDocument();
    expect(screen.getByText(/create 1 filter to auto-handle future mail/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /confirm & apply/i }));

    expect(await screen.findByText(/a@x\.com is now blocked/i)).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect((await store.senders.get(keyFor("a@x.com")))?.trustStatus).toBe("blocked");
    expect(gmail.createdFilters).toEqual([
      { from: "a@x.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    expect(onChanged).toHaveBeenCalledOnce();
    expect(await screen.findByRole("button", { name: /change to trust/i })).toBeInTheDocument();
  });

  it("reverses a blocked sender to trust, previewing the spam-rescue count", async () => {
    const { store, gmail } = setup();
    await store.senders.put(
      senderBuilder("spammy@x.com", { trustStatus: "blocked", spamMarkedCount: 4 }),
    );

    render(<Decisions store={store} gmail={gmail} online onChanged={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /change to trust/i }));
    expect(await screen.findByText(/restore 4 emails from spam\/trash/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /confirm & apply/i }));

    expect(await screen.findByText(/spammy@x\.com is now trusted/i)).toBeInTheDocument();
    expect((await store.senders.get(keyFor("spammy@x.com")))?.trustStatus).toBe("trusted");
  });

  it("cancels a pending change without applying it", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("keep@x.com", { trustStatus: "trusted" }));

    render(<Decisions store={store} gmail={gmail} online onChanged={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /change to block/i }));
    await screen.findByRole("alertdialog", { name: /confirm decision change/i });
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect((await store.senders.get(keyFor("keep@x.com")))?.trustStatus).toBe("trusted");
    expect(screen.getByRole("button", { name: /change to block/i })).toBeInTheDocument();
  });

  it("disables Confirm & apply until the impact preview resolves", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("a@x.com", { trustStatus: "trusted" }));
    gmail.seedInbox(inboxFromSender("a@x.com", 1));
    const stalled = deferred<string[]>();
    vi.spyOn(gmail, "listMessageIdsForSender").mockImplementationOnce(() => stalled.promise);

    render(<Decisions store={store} gmail={gmail} online onChanged={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /change to block/i }));
    expect(await screen.findByText(/checking impact/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /confirm & apply/i })).toBeDisabled();

    await act(async () => {
      stalled.resolve(["m1"]);
      await Promise.resolve();
    });

    expect(await screen.findByText(/archive 1 existing email/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /confirm & apply/i })).not.toBeDisabled();
  });

  it("surfaces an apply failure and keeps the confirm dialog open for retry", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("a@x.com", { trustStatus: "trusted" }));

    render(<Decisions store={store} gmail={gmail} online onChanged={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /change to block/i }));
    await screen.findByText(/create 1 filter to auto-handle future mail/i);

    vi.spyOn(store.senders, "put").mockRejectedValueOnce(new Error("write failed"));
    fireEvent.click(screen.getByRole("button", { name: /confirm & apply/i }));

    expect(
      await screen.findByText(/could not apply the change: write failed/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("alertdialog", { name: /confirm decision change/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /confirm & apply/i })).not.toBeDisabled();
  });

  it("filters the decided-subjects list by the search query", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("alpha@x.com", { trustStatus: "trusted" }));
    await store.senders.put(senderBuilder("beta@y.com", { trustStatus: "blocked" }));

    render(<Decisions store={store} gmail={gmail} online onChanged={vi.fn()} />);

    await screen.findByText("alpha@x.com");
    expect(screen.getByText("beta@y.com")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: /search decisions/i }), {
      target: { value: "alpha" },
    });

    expect(screen.getByText("alpha@x.com")).toBeInTheDocument();
    expect(screen.queryByText("beta@y.com")).not.toBeInTheDocument();
  });

  it("keeps the impact preview in sync with the subject when switching before the first preview resolves", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("a@x.com", { trustStatus: "trusted" }));
    await store.senders.put(senderBuilder("b@y.com", { trustStatus: "trusted" }));
    gmail.seedInbox([...inboxFromSender("a@x.com", 5), ...inboxFromSender("b@y.com", 1)]);

    // Stall subject A's simulateEnforcement call (its listMessageIdsForSender read) so it
    // resolves *after* subject B's, mirroring the race in the issue.
    const stalled = deferred<string[]>();
    vi.spyOn(gmail, "listMessageIdsForSender").mockImplementationOnce(() => stalled.promise);

    render(<Decisions store={store} gmail={gmail} online onChanged={vi.fn()} />);

    const buttons = await screen.findAllByRole("button", { name: /change to block/i });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!); // opens A; its preview is now stalled on `stalled.promise`
    fireEvent.click(buttons[1]!); // opens B before A's preview resolved

    // B's own preview resolves quickly and should be the one shown.
    expect(await screen.findByText(/archive 1 existing email/i)).toBeInTheDocument();
    expect(screen.getByRole("alertdialog", { name: /confirm decision change/i })).toHaveTextContent(
      "b@y.com",
    );

    // Now let A's stalled preview resolve — it must be discarded, not overwrite B's dialog.
    await act(async () => {
      stalled.resolve(["m1", "m2", "m3", "m4", "m5"]);
      await Promise.resolve();
    });

    expect(screen.getByRole("alertdialog", { name: /confirm decision change/i })).toHaveTextContent(
      "b@y.com",
    );
    expect(screen.getByText(/archive 1 existing email/i)).toBeInTheDocument();
    expect(screen.queryByText(/archive 5 existing emails/i)).not.toBeInTheDocument();
  });

  it("surfaces prior-decision suggestions and imports them as Blocked", async () => {
    const { store, gmail } = setup();
    gmail.seedInbox([
      messageMetaBuilder({ headers: { from: "junk@spam.com" }, labelIds: ["SPAM", "UNREAD"] }),
    ]);
    const onChanged = vi.fn();

    render(<Decisions store={store} gmail={gmail} online onChanged={onChanged} />);

    expect(await screen.findByText(/found 1 prior decision/i)).toBeInTheDocument();
    expect(screen.getByText("junk@spam.com")).toBeInTheDocument();
    expect(screen.getByText(/marked spam/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /import all as blocked/i }));

    expect(await screen.findByText(/imported 1 prior decision as blocked/i)).toBeInTheDocument();
    expect(screen.queryByText(/found 1 prior decision/i)).not.toBeInTheDocument();
    expect((await store.senders.get(keyFor("junk@spam.com")))?.trustStatus).toBe("blocked");
    expect(gmail.createdFilters).toEqual([
      { from: "junk@spam.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("dismisses prior-decision suggestions without importing them", async () => {
    const { store, gmail } = setup();
    gmail.seedInbox([
      messageMetaBuilder({ headers: { from: "junk@spam.com" }, labelIds: ["SPAM", "UNREAD"] }),
    ]);

    render(<Decisions store={store} gmail={gmail} online onChanged={vi.fn()} />);

    expect(await screen.findByText(/found 1 prior decision/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(screen.queryByText(/found 1 prior decision/i)).not.toBeInTheDocument();
    expect((await store.senders.get(keyFor("junk@spam.com")))).toBeUndefined();
  });

  it("blocks a trusted domain: previews the impact, applies it, and reconciles a Gmail filter", async () => {
    const { store, gmail } = setup();
    await store.domains.put(domainBuilder("promo.com", { trustStatus: "trusted" }));
    const onChanged = vi.fn();

    render(<Decisions store={store} gmail={gmail} online onChanged={onChanged} />);

    fireEvent.click(await screen.findByRole("button", { name: /change to block/i }));
    expect(screen.getByRole("alertdialog", { name: /confirm decision change/i })).toHaveTextContent(
      "promo.com",
    );
    expect(screen.getByText("whole domain")).toBeInTheDocument();
    expect(
      await screen.findByText(/create 1 filter to auto-handle future mail/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /confirm & apply/i }));

    expect(await screen.findByText(/promo\.com is now blocked/i)).toBeInTheDocument();
    expect((await store.domains.get(keyFor("promo.com")))?.trustStatus).toBe("blocked");
    expect(gmail.createdFilters).toEqual([
      { from: "*@promo.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    expect(onChanged).toHaveBeenCalledOnce();
    expect(await screen.findByRole("button", { name: /change to trust/i })).toBeInTheDocument();
  });

  it("reverses a blocked domain to trust", async () => {
    const { store, gmail } = setup();
    await store.domains.put(domainBuilder("promo.com", { trustStatus: "blocked" }));

    render(<Decisions store={store} gmail={gmail} online onChanged={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /change to trust/i }));
    expect(
      await screen.findByText(/records your decision on-device; no gmail changes needed/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /confirm & apply/i }));

    expect(await screen.findByText(/promo\.com is now trusted/i)).toBeInTheDocument();
    expect((await store.domains.get(keyFor("promo.com")))?.trustStatus).toBe("trusted");
  });

  it("surfaces a load failure and recovers via Retry", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("a@x.com", { trustStatus: "trusted" }));
    vi.spyOn(store.senders, "query").mockRejectedValueOnce(new Error("read failed"));

    render(<Decisions store={store} gmail={gmail} online onChanged={vi.fn()} />);

    expect(
      await screen.findByText(/couldn't load your decisions: read failed/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    expect(
      await screen.findByRole("button", { name: /change to block/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/couldn't load your decisions/i),
    ).not.toBeInTheDocument();
  });
});
