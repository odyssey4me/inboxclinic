// SPDX-License-Identifier: Apache-2.0
import { getBackupState, type Store } from "@inboxclinic/core";
import {
  createInMemoryStore,
  MockBackupClient,
  MockGmailClient,
  senderBuilder,
} from "@inboxclinic/core/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Settings } from "./Settings";

function setup(): { store: Store; backup: MockBackupClient; gmail: MockGmailClient } {
  return {
    store: createInMemoryStore(),
    backup: new MockBackupClient(),
    gmail: new MockGmailClient(),
  };
}

describe("Settings view", () => {
  it("enables backup (requesting drive.file consent) via the toggle", async () => {
    const { store, backup, gmail } = setup();
    render(
      <Settings
        store={store}
        backup={backup}
        gmail={gmail}
        online
        onRestored={vi.fn()}
        onRescan={vi.fn()}
        rescanning={false}
      />,
    );

    const toggle = await screen.findByRole("checkbox", { name: /enable google drive backup/i });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() => expect(backup.authorized).toBe(true));
    expect(await screen.findByText(/backup enabled/i)).toBeInTheDocument();
    expect((await getBackupState(store)).enabled).toBe(true);
  });

  it("backs up to Drive when enabled and reports the result", async () => {
    const { store, backup, gmail } = setup();
    await store.senders.put(senderBuilder("a@x.com"));
    render(
      <Settings
        store={store}
        backup={backup}
        gmail={gmail}
        online
        onRestored={vi.fn()}
        onRescan={vi.fn()}
        rescanning={false}
      />,
    );

    fireEvent.click(await screen.findByRole("checkbox", { name: /enable/i }));
    await screen.findByText(/backup enabled/i);

    fireEvent.click(screen.getByRole("button", { name: /back up now/i }));

    expect(await screen.findByText(/created .* in your drive/i)).toBeInTheDocument();
    expect(backup.currentData()).toBeDefined();
    expect((await getBackupState(store)).lastBackupAt).not.toBeNull();
  });

  it("gates actions until backup is enabled", async () => {
    const { store, backup, gmail } = setup();
    render(
      <Settings
        store={store}
        backup={backup}
        gmail={gmail}
        online
        onRestored={vi.fn()}
        onRescan={vi.fn()}
        rescanning={false}
      />,
    );

    expect(await screen.findByRole("button", { name: /back up now/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /restore from backup/i })).toBeDisabled();
  });

  it("restores only after confirming the replace-local warning", async () => {
    const { store, backup, gmail } = setup();
    await store.senders.put(senderBuilder("keep@x.com"));
    render(
      <Settings
        store={store}
        backup={backup}
        gmail={gmail}
        online
        onRestored={vi.fn()}
        onRescan={vi.fn()}
        rescanning={false}
      />,
    );

    // Enable + back up so a restore target exists.
    fireEvent.click(await screen.findByRole("checkbox", { name: /enable/i }));
    await screen.findByText(/backup enabled/i);
    fireEvent.click(screen.getByRole("button", { name: /back up now/i }));
    await screen.findByText(/in your drive/i);

    // Mutate, then restore.
    await store.senders.put(senderBuilder("added@y.com"));
    fireEvent.click(screen.getByRole("button", { name: /restore from backup/i }));

    // A confirmation dialog appears; the store is untouched until confirmed.
    expect(
      await screen.findByRole("alertdialog", { name: /confirm restore/i }),
    ).toBeInTheDocument();
    expect(await store.senders.query({})).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /replace local data/i }));

    await screen.findByText(/restore complete/i);
    expect(await store.senders.query({})).toHaveLength(1);
  });

  it("calls onRestored after a successful restore", async () => {
    const { store, backup, gmail } = setup();
    const onRestored = vi.fn();
    render(
      <Settings
        store={store}
        backup={backup}
        gmail={gmail}
        online
        onRestored={onRestored}
        onRescan={vi.fn()}
        rescanning={false}
      />,
    );

    fireEvent.click(await screen.findByRole("checkbox", { name: /enable/i }));
    await screen.findByText(/backup enabled/i);
    fireEvent.click(screen.getByRole("button", { name: /back up now/i }));
    await screen.findByText(/in your drive/i);

    fireEvent.click(screen.getByRole("button", { name: /restore from backup/i }));
    fireEvent.click(await screen.findByRole("button", { name: /replace local data/i }));

    await waitFor(() => expect(onRestored).toHaveBeenCalledOnce());
  });

  it("suggests and adopts an existing filter that already matches a desired one (#80)", async () => {
    const { store, backup, gmail } = setup();
    await store.senders.put(senderBuilder("spam@a.com", { trustStatus: "blocked" }));
    gmail.seedFilters([
      { id: "hand-made", from: "spam@a.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    render(
      <Settings
        store={store}
        backup={backup}
        gmail={gmail}
        online
        onRestored={vi.fn()}
        onRescan={vi.fn()}
        rescanning={false}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /check for adoptable filters/i }));
    expect(await screen.findByText(/spam@a.com/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /adopt 1 filter/i }));

    expect(await screen.findByText(/adopted 1 existing filter/i)).toBeInTheDocument();
    const sync = await store.filterSync.get();
    expect(sync?.managedFilterIds).toEqual(["hand-made"]);
    expect(gmail.createdFilters).toEqual([]);
  });
});
