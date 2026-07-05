// SPDX-License-Identifier: Apache-2.0
import type { Domain, Prompt, Profile, Sender, Store } from "@inboxclinic/core";
import { useCallback, useEffect, useState } from "react";

export interface StoreSnapshot {
  senders: Sender[];
  domains: Domain[];
  prompts: Prompt[];
  profile: Profile | undefined;
}

/**
 * Load the on-device data the UI renders, through the `Store` port (never Dexie
 * directly — design-frontend.md Decision 2/3). `reload()` re-reads after a write;
 * this is the manual-refresh stand-in for Dexie's `useLiveQuery`, kept port-agnostic
 * so the in-memory store fake works in tests.
 */
export function useStoreSnapshot(store: Store): {
  data: StoreSnapshot | null;
  reload: () => void;
} {
  const [data, setData] = useState<StoreSnapshot | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [senders, domains, prompts, profile] = await Promise.all([
        store.senders.query({}),
        store.domains.query({}),
        store.prompts.query({}),
        store.profile.get(),
      ]);
      if (active) setData({ senders, domains, prompts, profile });
    })();
    return () => {
      active = false;
    };
  }, [store, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, reload };
}
