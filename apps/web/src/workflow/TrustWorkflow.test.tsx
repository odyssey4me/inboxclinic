// SPDX-License-Identifier: Apache-2.0
import { keyFor, runScan, type Store } from "@inboxclinic/core";
import {
  createInMemoryStore,
  messageMetaBuilder,
  MockGmailClient,
} from "@inboxclinic/core/testing";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TrustWorkflow } from "./TrustWorkflow";

const NOW = 1_700_000_000_000;

interface Seeded {
  store: Store;
  gmail: MockGmailClient;
}

/** Seed an in-memory store by running a real scan over fixture senders. */
async function seededStore(froms: string[]): Promise<Seeded> {
  const gmail = new MockGmailClient(
    froms.map((from) => messageMetaBuilder({ headers: { from } })),
    "owner@gmail.com",
  );
  const store = createInMemoryStore();
  await runScan(gmail, store, { now: NOW });
  return { store, gmail };
}

const clickButton = async (name: RegExp): Promise<void> => {
  fireEvent.click(await screen.findByRole("button", { name }));
};

describe("TrustWorkflow", () => {
  it("walks Triage → Review → Execution, persists, and enforces in Gmail", async () => {
    const { store, gmail } = await seededStore(["jane@acme.com", "news@promo.com"]);
    const onDone = vi.fn();
    render(<TrustWorkflow store={store} gmail={gmail} onDone={onDone} />);

    // First prompt: trust (actions are inline — no "make a decision" step).
    await clickButton(/^trust$/i);

    // Second prompt: block in one tap (smart defaults staged).
    await clickButton(/^block$/i);

    // Review summarises, then Execution applies + enforces.
    await clickButton(/apply changes/i);
    await screen.findByText(/gmail enforcement/i);
    await clickButton(/^done$/i);

    expect(onDone).toHaveBeenCalledOnce();
    expect((await store.senders.query({ trustStatus: "trusted" })).length).toBe(1);
    expect((await store.senders.query({ trustStatus: "blocked" })).length).toBe(1);
    const prompts = await store.prompts.query({});
    expect(prompts.every((p) => p.resolvedAt !== null)).toBe(true);

    // The block compiled into exactly one native Gmail filter (no live Google).
    expect(gmail.createdFilters).toEqual([
      { from: "news@promo.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    const sync = await store.filterSync.get();
    expect(sync?.totalFilters).toBe(1);
  });

  it("defers a sender: decays the prompt without resolving it and creates no filters", async () => {
    const { store, gmail } = await seededStore(["solo@quiet.com"]);
    render(<TrustWorkflow store={store} gmail={gmail} onDone={vi.fn()} />);

    await clickButton(/defer/i);
    await clickButton(/apply changes/i);
    await clickButton(/^done$/i);

    const [prompt] = await store.prompts.query({});
    expect(prompt?.resolvedAt).toBeNull();
    expect(prompt?.deferredAt).not.toBeNull();
    const [sender] = await store.senders.query({});
    expect(sender?.trustStatus).toBe("pending");
    expect(gmail.createdFilters).toEqual([]);
  });

  it("decides a whole domain from the batch offer", async () => {
    const { store, gmail } = await seededStore(["a@acme.com", "b@acme.com"]);
    const onDone = vi.fn();
    render(<TrustWorkflow store={store} gmail={gmail} onDone={onDone} />);

    await clickButton(/decide for the whole domain/i);
    await clickButton(/^trust$/i);
    await clickButton(/apply changes/i);
    await clickButton(/^done$/i);

    const domain = await store.domains.get(keyFor("acme.com"));
    expect(domain?.trustStatus).toBe("trusted");
    expect(domain?.decisionScope).toBe("domain");
    const prompts = await store.prompts.query({});
    expect(prompts.every((p) => p.resolvedAt !== null)).toBe(true);
  });

  /**
   * Give the scanned senders a prior-block signal so the current sender has flagged siblings
   * (learnPriorDecisions doesn't run in this harness), then render the workflow.
   */
  async function seededFlagged(froms: string[]): Promise<Seeded> {
    const seeded = await seededStore(froms);
    for (const s of await seeded.store.senders.query({})) {
      await seeded.store.senders.put({ ...s, spamMarkedCount: 1 });
    }
    return seeded;
  }

  it("offers the flagged-siblings consolidation in Triage and keeps them all in one step (#129)", async () => {
    const { store, gmail } = await seededFlagged([
      "deals@shop.example",
      "news@shop.example",
      "promo@shop.example",
    ]);
    render(<TrustWorkflow store={store} gmail={gmail} onDone={vi.fn()} />);

    // The compact offer surfaces the two other flagged senders on the domain.
    await screen.findByText(/2 other flagged senders/i);
    await clickButton(/keep all/i);

    await clickButton(/apply changes/i);
    await clickButton(/^done$/i);

    // Current + both siblings are staged and applied as trust; no filters for a keep.
    expect((await store.senders.query({ trustStatus: "trusted" })).length).toBe(3);
    const prompts = await store.prompts.query({});
    expect(prompts.every((p) => p.resolvedAt !== null)).toBe(true);
    expect(gmail.createdFilters).toEqual([]);
  });

  it("blocks a flagged sibling group from the workflow offer (one filter each)", async () => {
    const { store, gmail } = await seededFlagged(["deals@shop.example", "news@shop.example"]);
    render(<TrustWorkflow store={store} gmail={gmail} onDone={vi.fn()} />);

    await clickButton(/block all 2/i);
    await clickButton(/apply changes/i);
    await screen.findByText(/gmail enforcement/i);
    await clickButton(/^done$/i);

    expect((await store.senders.query({ trustStatus: "blocked" })).length).toBe(2);
    expect(gmail.createdFilters.length).toBe(2);
  });

  it("defers a flagged sibling group with 'Not now' without resolving prompts", async () => {
    const { store, gmail } = await seededFlagged(["deals@shop.example", "news@shop.example"]);
    render(<TrustWorkflow store={store} gmail={gmail} onDone={vi.fn()} />);

    await clickButton(/not now/i);
    await clickButton(/apply changes/i);
    await clickButton(/^done$/i);

    const senders = await store.senders.query({});
    expect(senders.every((s) => s.trustStatus === "pending")).toBe(true);
    const prompts = await store.prompts.query({});
    expect(prompts.every((p) => p.deferredAt !== null && p.resolvedAt === null)).toBe(true);
    expect(gmail.createdFilters).toEqual([]);
  });
});
