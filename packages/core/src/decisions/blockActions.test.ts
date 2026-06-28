import { describe, expect, it } from "vitest";

import { defaultBlockActions } from "./blockActions";

describe("defaultBlockActions", () => {
  it("offers unsubscribe only when List-Unsubscribe is present", () => {
    expect(defaultBlockActions({ hasListUnsubscribe: true, category: "promotional" })).toContain(
      "unsubscribe",
    );
    expect(
      defaultBlockActions({ hasListUnsubscribe: false, category: "promotional" }),
    ).not.toContain("unsubscribe");
  });

  it("always includes a filter and archives promotional/other", () => {
    expect(defaultBlockActions({ hasListUnsubscribe: false, category: "promotional" })).toEqual([
      "create_filter",
      "archive",
    ]);
    expect(defaultBlockActions({ hasListUnsubscribe: false, category: "other" })).toEqual([
      "create_filter",
      "archive",
    ]);
  });

  it("does not archive personal/transactional senders by default", () => {
    expect(defaultBlockActions({ hasListUnsubscribe: false, category: "personal" })).toEqual([
      "create_filter",
    ]);
    expect(defaultBlockActions({ hasListUnsubscribe: true, category: "transactional" })).toEqual([
      "unsubscribe",
      "create_filter",
    ]);
  });
});
