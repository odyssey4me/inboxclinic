// SPDX-License-Identifier: Apache-2.0
import type { Domain, Prompt, Profile, Sender, Store } from "@inboxclinic/core";
import { useCallback, useEffect, useState } from "react";

import { recordError } from "../reporting/recentErrors";

export interface StoreSnapshot {
  senders: Sender[];
  domains: Domain[];
  prompts: Prompt[];
  profile: Profile | undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Load the on-device data the UI renders, through the `Store` port (never Dexie
 * directly — design-frontend.md Decision 2/3). `reload()` re-reads after a write;
 * this is the manual-refresh stand-in for Dexie's `useLiveQuery`, kept port-agnostic
 * so the in-memory store fake works in tests.
 *
 * A rejected read (quota errors, a blocked IndexedDB upgrade, storage pressure) is
 * caught and surfaced via `error` instead of leaving `data` stuck at `null` forever —
 * callers can render a retry affordance that calls `reload()`.
 */
export function useStoreSnapshot(store: Store): {
  data: StoreSnapshot | null;
  error: string | null;
  reload: () => void;
} {
  const [data, setData] = useState<StoreSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let active = true;
    setError(null);
    void (async () => {
      try {
        const [senders, domains, prompts, profile] = await Promise.all([
          store.senders.query({}),
          store.domains.query({}),
          store.prompts.query({}),
          store.profile.get(),
        ]);
        if (active) setData({ senders, domains, prompts, profile });
      } catch (caught) {
        if (!active) return;
        recordError(caught, { view: "useStoreSnapshot" });
        setError(errorMessage(caught));
      }
    })();
    return () => {
      active = false;
    };
  }, [store, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, reload };
}
