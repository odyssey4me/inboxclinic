// SPDX-License-Identifier: Apache-2.0
import { keyFor, type Store } from "@inboxclinic/core";
import { createInMemoryStore, MockGmailClient, senderBuilder } from "@inboxclinic/core/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SenderDetail } from "./SenderDetail";

function setup(): { store: Store; gmail: MockGmailClient } {
  return { store: createInMemoryStore(), gmail: new MockGmailClient() };
}

describe("SenderDetail — flagged siblings (#96)", () => {
  it("offers to block all flagged same-domain siblings together, previewed and confirmed", async () => {
    const { store, gmail } = setup();
    const a = senderBuilder("a@shop.com", { spamMarkedCount: 1 });
    const b = senderBuilder("b@shop.com", { coveredByBlockFilter: true });
    await store.senders.put(a);
    await store.senders.put(b);
    const onChanged = vi.fn();
    const onClose = vi.fn();

    render(
      <SenderDetail
        sender={a}
        flaggedSiblings={[b]}
        store={store}
        gmail={gmail}
        online
        onClose={onClose}
        onChanged={onChanged}
      />,
    );

    // The offer surfaces the flagged sibling; blocking previews impact before applying.
    expect(screen.getByText(/1 other flagged sender/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /block all 2/i }));

    fireEvent.click(await screen.findByRole("button", { name: /confirm block all/i }));

    await waitFor(async () => {
      expect((await store.senders.get(keyFor("a@shop.com")))?.trustStatus).toBe("blocked");
      expect((await store.senders.get(keyFor("b@shop.com")))?.trustStatus).toBe("blocked");
    });
    expect(onChanged).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps all flagged siblings (trust) in one step", async () => {
    const { store, gmail } = setup();
    await store.senders.put(senderBuilder("a@shop.com", { spamMarkedCount: 1 }));
    await store.senders.put(senderBuilder("b@shop.com", { coveredByBlockFilter: true }));

    render(
      <SenderDetail
        sender={senderBuilder("a@shop.com", { spamMarkedCount: 1 })}
        flaggedSiblings={[senderBuilder("b@shop.com", { coveredByBlockFilter: true })]}
        store={store}
        gmail={gmail}
        online
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /keep all/i }));

    await waitFor(async () => {
      expect((await store.senders.get(keyFor("a@shop.com")))?.trustStatus).toBe("trusted");
      expect((await store.senders.get(keyFor("b@shop.com")))?.trustStatus).toBe("trusted");
    });
  });

  it("shows no flagged-siblings offer when there are none", () => {
    const { store, gmail } = setup();
    render(
      <SenderDetail
        sender={senderBuilder("solo@x.com")}
        store={store}
        gmail={gmail}
        online
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.queryByText(/other flagged sender/i)).not.toBeInTheDocument();
    // The normal single-sender actions still render.
    expect(screen.getByRole("button", { name: /^Trust$/ })).toBeInTheDocument();
  });
});
