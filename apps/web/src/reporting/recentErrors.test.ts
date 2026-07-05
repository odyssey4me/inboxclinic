// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";

import { clearRecentErrors, getRecentErrors, latestError, recordError } from "./recentErrors";

afterEach(() => clearRecentErrors());

describe("recentErrors", () => {
  it("records newest-first with message, stack, and view", () => {
    recordError(new Error("boom"), { view: "sync" });
    const latest = latestError();
    expect(latest?.message).toBe("boom");
    expect(latest?.view).toBe("sync");
    expect(latest?.stack).toBeDefined();
    expect(typeof latest?.at).toBe("number");
  });

  it("coerces non-Error values", () => {
    recordError("just a string");
    expect(latestError()?.message).toBe("just a string");
  });

  it("keeps newest first across multiple records", () => {
    recordError(new Error("first"));
    recordError(new Error("second"));
    expect(getRecentErrors()[0]?.message).toBe("second");
  });

  it("caps the buffer at 20 entries", () => {
    for (let i = 0; i < 25; i++) recordError(new Error(`e${i}`));
    expect(getRecentErrors()).toHaveLength(20);
    expect(getRecentErrors()[0]?.message).toBe("e24");
  });
});
