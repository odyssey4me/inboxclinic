// SPDX-License-Identifier: Apache-2.0
import type { Store } from "@inboxclinic/core";
import {
  createInMemoryStore,
  inboxFromSender,
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
});
