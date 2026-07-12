// SPDX-License-Identifier: Apache-2.0
/** Shared helpers for reading existing native filters (learning + optimisation). */

import type { NativeFilter } from "../ports/GmailClient";
import type { DecisionScope } from "../store";

/** A filter that removes mail from the inbox (trash / spam / archive) is a "block". */
export function isBlockFilter(
  filter: Pick<NativeFilter, "addLabelIds" | "removeLabelIds">,
): boolean {
  return (
    filter.addLabelIds.includes("TRASH") ||
    filter.addLabelIds.includes("SPAM") ||
    filter.removeLabelIds.includes("INBOX")
  );
}

/** Parse a filter `from` ("a@x.com", "*@x.com", or "*@a.com OR *@b.com") into subjects. */
export function parseFilterSubjects(from: string): { scope: DecisionScope; value: string }[] {
  const out: { scope: DecisionScope; value: string }[] = [];
  // Normalise whitespace first (linear), then split on a literal " OR " so the
  // separator regex carries no unbounded quantifier — avoids polynomial ReDoS.
  for (const token of from.replace(/\s+/g, " ").split(/ OR /i)) {
    const value = token.trim().toLowerCase();
    if (value === "") continue;
    if (value.startsWith("*@")) out.push({ scope: "domain", value: value.slice(2) });
    else if (value.includes("@")) out.push({ scope: "address", value });
  }
  return out;
}
