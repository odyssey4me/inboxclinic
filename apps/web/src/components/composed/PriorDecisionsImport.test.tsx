// SPDX-License-Identifier: Apache-2.0
import { keyFor, type Store } from "@inboxclinic/core";
import {
  createInMemoryStore,
  messageMetaBuilder,
  MockGmailClient,
} from "@inboxclinic/core/testing";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PriorDecisionsImport } from "./PriorDecisionsImport";

function setup(): { store: Store; gmail: MockGmailClient } {
  return { store: createInMemoryStore(), gmail: new MockGmailClient() };
}

describe("PriorDecisionsImport", () => {
  it("surfaces prior-decision suggestions and imports them as Blocked", async () => {
    const { store, gmail } = setup();
    gmail.seedInbox([
      messageMetaBuilder({ headers: { from: "junk@spam.com" }, labelIds: ["SPAM", "UNREAD"] }),
    ]);
    const onImported = vi.fn();

    render(<PriorDecisionsImport store={store} gmail={gmail} online onImported={onImported} />);

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
    expect(onImported).toHaveBeenCalledOnce();
  });

  it("dismisses prior-decision suggestions without importing them", async () => {
    const { store, gmail } = setup();
    gmail.seedInbox([
      messageMetaBuilder({ headers: { from: "junk@spam.com" }, labelIds: ["SPAM", "UNREAD"] }),
    ]);
    const onImported = vi.fn();

    render(<PriorDecisionsImport store={store} gmail={gmail} online onImported={onImported} />);

    expect(await screen.findByText(/found 1 prior decision/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(screen.queryByText(/found 1 prior decision/i)).not.toBeInTheDocument();
    expect(await store.senders.get(keyFor("junk@spam.com"))).toBeUndefined();
    expect(onImported).not.toHaveBeenCalled();
  });

  it("renders nothing when there are no prior decisions to import", async () => {
    const { store, gmail } = setup();
    const { container } = render(
      <PriorDecisionsImport store={store} gmail={gmail} online onImported={vi.fn()} />,
    );
    // No filters/spam/trash seeded → learnPriorDecisions finds nothing → the card stays hidden.
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });
});
