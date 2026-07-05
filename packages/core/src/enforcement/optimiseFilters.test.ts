// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { MockGmailClient } from "../testing";
import { applyFilterOptimisations, suggestFilterOptimisations } from "./optimiseFilters";

const block = (id: string, from: string) => ({
  id,
  from,
  addLabelIds: ["TRASH"],
  removeLabelIds: ["INBOX"],
});

describe("suggestFilterOptimisations", () => {
  it("suggests consolidating several same-domain address filters into a domain rule", async () => {
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      block("f1", "a@spam.com"),
      block("f2", "b@spam.com"),
      block("f3", "c@spam.com"),
      block("f4", "keep@other.com"),
    ]);

    const out = await suggestFilterOptimisations(gmail);
    const consolidate = out.find((o) => o.kind === "consolidate");
    expect(consolidate?.createFilter?.from).toBe("*@spam.com");
    expect(consolidate?.removeFilterIds.sort()).toEqual(["f1", "f2", "f3"]);
  });

  it("flags duplicate filters", async () => {
    const gmail = new MockGmailClient();
    gmail.seedFilters([block("f1", "dupe@x.com"), block("f2", "dupe@x.com")]);

    const dup = (await suggestFilterOptimisations(gmail)).find((o) => o.kind === "duplicate");
    expect(dup?.removeFilterIds).toEqual(["f2"]);
  });

  it("flags an address filter already covered by a domain filter as redundant", async () => {
    const gmail = new MockGmailClient();
    gmail.seedFilters([block("f1", "*@ads.com"), block("f2", "promo@ads.com")]);

    const redundant = (await suggestFilterOptimisations(gmail)).find((o) => o.kind === "redundant");
    expect(redundant?.removeFilterIds).toEqual(["f2"]);
  });

  it("ignores non-block filters and tidy accounts", async () => {
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      { id: "s1", from: "friend@x.com", addLabelIds: ["STARRED"], removeLabelIds: [] },
      block("f1", "a@x.com"),
      block("f2", "b@y.com"),
    ]);

    expect(await suggestFilterOptimisations(gmail)).toHaveLength(0);
  });

  it("applyFilterOptimisations creates the replacement then deletes the old filters", async () => {
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      block("f1", "a@spam.com"),
      block("f2", "b@spam.com"),
      block("f3", "c@spam.com"),
    ]);

    const suggestions = await suggestFilterOptimisations(gmail);
    const result = await applyFilterOptimisations(gmail, suggestions);

    expect(result.filtersCreated).toBe(1);
    expect(result.filtersDeleted).toBe(3);
    expect(gmail.createdFilters).toEqual([
      { from: "*@spam.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    expect(gmail.deletedFilterIds.sort()).toEqual(["f1", "f2", "f3"]);
  });
});
