// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { toNativeFilter } from "./BrowserGmailClient";

// `toNativeFilter` is where a raw Gmail filter becomes the port's lossy projection of one, and
// where the app decides whether a filter is its own. Get it wrong in either direction and the
// consequences are severe and silent: disown a managed filter and reconcile recreates the whole
// set on every sync; miss real criteria and the tidy-up deletes a rule the user built (#212).

describe("toNativeFilter", () => {
  it("claims a filter the app itself would create — no unmodelled criteria", () => {
    const filter = toNativeFilter({
      id: "f1",
      criteria: { from: "*@shop.test", negatedQuery: "from:(vip@shop.test)" },
      action: { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    });

    expect(filter.unmodelledCriteria).toBeUndefined();
    // …and the exclusion is unwrapped back to the spec form, so reconcile compares equal.
    expect(filter.excludeFrom).toBe("vip@shop.test");
  });

  it("names the criteria it had to drop", () => {
    const filter = toNativeFilter({
      id: "f2",
      criteria: { from: "news@shop.test", subject: "sale", to: "me@x.test" },
      action: { addLabelIds: ["TRASH"] },
    });

    // Sorted, so the value is stable to compare and to read in a report.
    expect(filter.unmodelledCriteria).toEqual(["subject", "to"]);
    expect(filter.from).toBe("news@shop.test");
    expect(filter.removeLabelIds).toEqual([]);
  });

  it("does not disown a filter over an echoed default that constrains nothing", () => {
    // Gmail's JSON normally omits defaults, but if one ever came back, treating it as a real
    // criterion would make every managed filter foreign at once — and reconcile would then
    // recreate the entire managed set on every sync.
    const filter = toNativeFilter({
      id: "f3",
      criteria: {
        from: "*@shop.test",
        excludeChats: false,
        subject: "",
        hasAttachment: null,
        labelIds: [],
      } as never,
      action: { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    });

    expect(filter.unmodelledCriteria).toBeUndefined();
  });

  it("still flags a field whose value does constrain matching", () => {
    const filter = toNativeFilter({
      id: "f4",
      criteria: { from: "*@shop.test", excludeChats: true } as never,
      action: { addLabelIds: ["TRASH"] },
    });

    expect(filter.unmodelledCriteria).toEqual(["excludeChats"]);
  });

  it("degrades safely on a filter with no criteria or action at all", () => {
    const filter = toNativeFilter({ id: "f5" });

    expect(filter).toEqual({ id: "f5", from: "", addLabelIds: [], removeLabelIds: [] });
  });
});
