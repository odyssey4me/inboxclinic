// SPDX-License-Identifier: Apache-2.0
/**
 * Regression coverage for the KV rate-limit race (#194): a shared counter's read-then-write
 * can race under concurrent requests and silently lose increments. `withinLimit` fixes this
 * with one KV entry per accepted request, counted by prefix `list()` — see report.ts.
 */
import { describe, expect, it } from "vitest";

import { withinLimit } from "./report";

function createKv() {
  const keys = new Map<string, string>();
  return {
    keys,
    kv: {
      async put(key: string, value: string) {
        keys.set(key, value);
      },
      async list({ prefix }: { prefix: string }) {
        return {
          keys: [...keys.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        };
      },
    },
  };
}

describe("withinLimit", () => {
  it("allows up to the limit, then blocks", async () => {
    const { kv } = createKv();
    for (let i = 0; i < 3; i++) {
      expect(await withinLimit(kv, "rl:ip:abc", 3)).toBe(true);
    }
    expect(await withinLimit(kv, "rl:ip:abc", 3)).toBe(false);
  });

  it("keeps every accepted request's entry through a concurrent burst, so the limit still holds afterwards", async () => {
    const { kv, keys } = createKv();
    // A burst of concurrent requests racing the same key — the scenario from #194, where
    // every request reads the pre-burst count before any write is visible.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => withinLimit(kv, "rl:ip:burst", 3)),
    );
    const accepted = results.filter(Boolean).length;
    // Per-request entries never clobber each other, so no accepted request is lost — the
    // store holds exactly one entry per acceptance (a shared counter could under-count this
    // after concurrent writes overwrite each other).
    expect(keys.size).toBe(accepted);
    // Once the burst has landed, the next request is correctly blocked.
    expect(await withinLimit(kv, "rl:ip:burst", 3)).toBe(false);
  });
});
