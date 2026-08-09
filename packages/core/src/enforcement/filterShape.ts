// SPDX-License-Identifier: Apache-2.0
/** Shared helpers for reading existing native filters (learning + optimisation). */

import type { NativeFilter } from "../ports/GmailClient";
import type { DecisionScope } from "../store";

/**
 * Whether a filter matches on criteria this port does not model (`to`, `subject`, `query`, …).
 *
 * Such a filter is **foreign by construction**: the app only ever creates filters from a
 * `FilterSpec`, so anything carrying more is something the user built. Every path that
 * reasons about a filter's identity or meaning must exclude it — it is never a duplicate of
 * a rule that merely looks like it, never adoptable, never deletable, and never evidence of
 * a prior decision, because we cannot see what it actually does (#212).
 */
export function carriesUnmodelledCriteria(
  filter: Pick<NativeFilter, "unmodelledCriteria">,
): boolean {
  return (filter.unmodelledCriteria?.length ?? 0) > 0;
}

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

/**
 * Our `negatedQuery` shape `from:(a OR b)` → the `excludeFrom` addresses `a OR b`.
 *
 * The inverse of the wrap `compileFilters`/the provider adapter apply when sending
 * `excludeFrom` to Gmail. Reading it back is what lets reconcile compare a stored filter
 * against a desired `FilterSpec` and see them as equal (#145) — get this wrong and a
 * filter with an exception looks "missing" every sync. The one canonical implementation:
 * every provider adapter and replay tool must call this rather than re-deriving it (#216).
 */
export function unwrapExcludeFrom(negatedQuery: string | undefined): string | undefined {
  if (negatedQuery === undefined) return undefined;
  const match = /^from:\((.*)\)$/s.exec(negatedQuery);
  return match ? match[1] : negatedQuery;
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
