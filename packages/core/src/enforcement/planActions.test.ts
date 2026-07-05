// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { planActions } from "./planActions";

describe("planActions", () => {
  it("blocks with create_filter only → filter flag, no message mutation", () => {
    const plan = planActions({ decision: "block", actions: ["create_filter"] });
    expect(plan).toEqual({ createFilter: true, unsubscribe: false, messageMutation: null });
  });

  it("blocks with archive → removes INBOX from existing messages", () => {
    const plan = planActions({ decision: "block", actions: ["create_filter", "archive"] });
    expect(plan.messageMutation).toEqual({ addLabelIds: [], removeLabelIds: ["INBOX"] });
  });

  it("blocks with delete → adds TRASH and removes INBOX (delete beats archive)", () => {
    const plan = planActions({ decision: "block", actions: ["archive", "delete"] });
    expect(plan.messageMutation).toEqual({ addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] });
  });

  it("offers unsubscribe only when List-Unsubscribe is present", () => {
    expect(
      planActions({ decision: "block", actions: ["unsubscribe"], hasListUnsubscribe: true })
        .unsubscribe,
    ).toBe(true);
    expect(
      planActions({ decision: "block", actions: ["unsubscribe"], hasListUnsubscribe: false })
        .unsubscribe,
    ).toBe(false);
  });

  it("a trust decision on a spam-marked sender plans a rescue (remove SPAM/TRASH)", () => {
    const plan = planActions({ decision: "trust", spamMarkedCount: 4 });
    expect(plan).toEqual({
      createFilter: false,
      unsubscribe: false,
      messageMutation: { removeLabelIds: ["SPAM", "TRASH"] },
    });
  });

  it("a trust decision on a clean sender plans nothing", () => {
    expect(planActions({ decision: "trust", spamMarkedCount: 0 }).messageMutation).toBeNull();
  });

  it("defer compiles to no operations", () => {
    expect(planActions({ decision: "defer" })).toEqual({
      createFilter: false,
      unsubscribe: false,
      messageMutation: null,
    });
  });

  it("tolerates a block with no staged actions", () => {
    expect(planActions({ decision: "block" })).toEqual({
      createFilter: false,
      unsubscribe: false,
      messageMutation: null,
    });
  });
});
