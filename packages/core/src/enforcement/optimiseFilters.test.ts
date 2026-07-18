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

const carved = (id: string, from: string, excludeFrom: string) => ({
  id,
  from,
  excludeFrom,
  addLabelIds: ["TRASH"],
  removeLabelIds: ["INBOX"],
});

describe("suggestFilterOptimisations", () => {
  it("does not treat differently-excluded domain filters as duplicates (#145)", async () => {
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      block("plain", "*@shop.com"),
      carved("carve", "*@shop.com", "vip@shop.com"),
    ]);

    const out = await suggestFilterOptimisations(gmail);

    expect(out.filter((o) => o.kind === "duplicate")).toEqual([]);
  });

  it("does not flag an excluded address as redundant under its domain filter (#145)", async () => {
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      carved("dom", "*@shop.com", "vip@shop.com"),
      block("vip", "vip@shop.com"), // the carved-out address — still doing real work
      block("junk", "junk@shop.com"), // genuinely covered by the domain rule
    ]);

    const out = await suggestFilterOptimisations(gmail);

    const redundant = out.filter((o) => o.kind === "redundant").flatMap((o) => o.removeFilterIds);
    expect(redundant).toEqual(["junk"]);
  });

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
    expect(result.failures).toEqual([]);
    expect(gmail.createdFilters).toEqual([
      { from: "*@spam.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    expect(gmail.deletedFilterIds.sort()).toEqual(["f1", "f2", "f3"]);
  });

  it("dedupes filter ids referenced by both the duplicate and consolidate passes", async () => {
    const gmail = new MockGmailClient();
    // Three byte-for-byte identical single-address filters: flagged as a
    // "duplicate" set (keep f1) AND as a "consolidate" set (all three), since
    // they're also three uncovered address rules for the same domain.
    gmail.seedFilters([
      block("f1", "a@spam.com"),
      block("f2", "a@spam.com"),
      block("f3", "a@spam.com"),
    ]);

    const suggestions = await suggestFilterOptimisations(gmail);
    const referenced = suggestions.flatMap((s) => s.removeFilterIds);

    // No id appears in more than one suggestion's removeFilterIds.
    expect(new Set(referenced).size).toBe(referenced.length);

    const result = await applyFilterOptimisations(gmail, suggestions);
    expect(result.filtersDeleted).toBe(3);
    expect(gmail.deletedFilterIds.sort()).toEqual(["f1", "f2", "f3"]);
    // Each id was deleted exactly once.
    expect(gmail.deletedFilterIds).toHaveLength(new Set(gmail.deletedFilterIds).size);
  });

  it("applyFilterOptimisations is best-effort — a failing delete is recorded, not thrown", async () => {
    class FlakyClient extends MockGmailClient {
      override deleteFilter(id: string): Promise<void> {
        if (id === "f2") throw new Error("boom");
        return super.deleteFilter(id);
      }
    }
    const gmail = new FlakyClient();
    gmail.seedFilters([block("f1", "dupe@x.com"), block("f2", "dupe@x.com")]);

    const suggestions = await suggestFilterOptimisations(gmail);
    const result = await applyFilterOptimisations(gmail, suggestions);

    expect(result.filtersDeleted).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toEqual({ subject: "filter:f2", error: "boom" });
  });

  it("applyFilterOptimisations continues past a failed create to still delete the old filters", async () => {
    class FlakyClient extends MockGmailClient {
      override createFilter(): never {
        throw new Error("boom");
      }
    }
    const gmail = new FlakyClient();
    gmail.seedFilters([
      block("f1", "a@spam.com"),
      block("f2", "b@spam.com"),
      block("f3", "c@spam.com"),
    ]);

    const suggestions = await suggestFilterOptimisations(gmail);
    const result = await applyFilterOptimisations(gmail, suggestions);

    expect(result.filtersCreated).toBe(0);
    expect(result.filtersDeleted).toBe(3);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toEqual({ subject: "filter:*@spam.com", error: "boom" });
  });
});
