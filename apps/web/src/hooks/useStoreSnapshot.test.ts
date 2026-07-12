// SPDX-License-Identifier: Apache-2.0
import { createInMemoryStore } from "@inboxclinic/core/testing";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useStoreSnapshot } from "./useStoreSnapshot";

describe("useStoreSnapshot", () => {
  it("loads a snapshot from the store", async () => {
    const store = createInMemoryStore();
    const { result } = renderHook(() => useStoreSnapshot(store));

    await waitFor(() => expect(result.current.data).not.toBeNull());

    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({
      senders: [],
      domains: [],
      prompts: [],
      profile: undefined,
    });
  });

  it("surfaces a rejected read as an error instead of leaving data stuck at null", async () => {
    const store = createInMemoryStore();
    store.senders.query = () => Promise.reject(new Error("Quota exceeded"));
    const { result } = renderHook(() => useStoreSnapshot(store));

    await waitFor(() => expect(result.current.error).not.toBeNull());

    expect(result.current.error).toBe("Quota exceeded");
    expect(result.current.data).toBeNull();
  });

  it("clears the error and loads data once reload() succeeds", async () => {
    const store = createInMemoryStore();
    let fail = true;
    const query = store.senders.query.bind(store.senders);
    store.senders.query = (filter) =>
      fail ? Promise.reject(new Error("Quota exceeded")) : query(filter);
    const { result } = renderHook(() => useStoreSnapshot(store));

    await waitFor(() => expect(result.current.error).not.toBeNull());

    fail = false;
    act(() => result.current.reload());

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.error).toBeNull();
  });
});
