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

/** Seed an in-memory store by running a real scan over fixture senders. */
async function seededStore(froms: string[]): Promise<Store> {
  const gmail = new MockGmailClient(
    froms.map((from) => messageMetaBuilder({ headers: { from } })),
    "owner@gmail.com",
  );
  const store = createInMemoryStore();
  await runScan(gmail, store, { now: NOW });
  return store;
}

const clickButton = async (name: RegExp): Promise<void> => {
  fireEvent.click(await screen.findByRole("button", { name }));
};

describe("TrustWorkflow", () => {
  it("walks Discovery → Decision → Review → Execution and persists decisions", async () => {
    const store = await seededStore(["jane@acme.com", "news@promo.com"]);
    const onDone = vi.fn();
    render(<TrustWorkflow store={store} onDone={onDone} />);

    // First prompt: Discovery → Decision → Trust.
    await clickButton(/make a decision/i);
    await clickButton(/^trust$/i);

    // Second prompt: Discovery → Decision → Block (confirm staged actions).
    await clickButton(/make a decision/i);
    await clickButton(/block…/i);
    await clickButton(/confirm block/i);

    // Review summarises, then Execution applies.
    await clickButton(/apply changes/i);
    await clickButton(/^done$/i);

    expect(onDone).toHaveBeenCalledOnce();
    expect((await store.senders.query({ trustStatus: "trusted" })).length).toBe(1);
    expect((await store.senders.query({ trustStatus: "blocked" })).length).toBe(1);
    const prompts = await store.prompts.query({});
    expect(prompts.every((p) => p.resolvedAt !== null)).toBe(true);
  });

  it("defers a sender: decays the prompt without resolving it", async () => {
    const store = await seededStore(["solo@quiet.com"]);
    render(<TrustWorkflow store={store} onDone={vi.fn()} />);

    await clickButton(/make a decision/i);
    await clickButton(/defer/i);
    await clickButton(/apply changes/i);
    await clickButton(/^done$/i);

    const [prompt] = await store.prompts.query({});
    expect(prompt?.resolvedAt).toBeNull();
    expect(prompt?.deferredAt).not.toBeNull();
    const [sender] = await store.senders.query({});
    expect(sender?.trustStatus).toBe("pending");
  });

  it("decides a whole domain from the batch offer", async () => {
    const store = await seededStore(["a@acme.com", "b@acme.com"]);
    const onDone = vi.fn();
    render(<TrustWorkflow store={store} onDone={onDone} />);

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
});
