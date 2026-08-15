// SPDX-License-Identifier: Apache-2.0
/**
 * Replay the LIVE Public Suffix List through the app's eTLD+1 helpers —
 * docs/design-testing.md Decision 9 (real-account probes), #252.
 *
 * `registrableDomain.property.test.ts` composes hosts from six suffixes we chose. The real
 * list has 10,000+, and its hard cases are the ones nobody thinks to pick: wildcard rules
 * (`*.ck` — every `X.ck` is itself a suffix), exception rules (`!www.ck` — which claws one
 * back), multi-label suffixes, and the whole PRIVATE section that `allowPrivateDomains: true`
 * makes load-bearing (design-trust-decisions.md Decision 9).
 *
 * Skipped unless a corpus is supplied, so it costs nothing in CI and no test ever touches the
 * network:
 *
 *   ./scripts/fetch-psl-corpus.sh
 *   INBOXCLINIC_PSL_CORPUS=$PWD/.local/psl.json npx vitest run --root packages/core realSuffixes
 *
 * **What is asserted vs reported.** `tldts` embeds its own snapshot of the list, which
 * necessarily lags the live one — a suffix registered last week is not a bug in this code.
 * So a rule the bundled snapshot does not recognise is *reported* (criterion 5: evidence, not
 * a verdict), and the invariants are asserted only over the rules it does. The report is the
 * finding: it measures how far the snapshot has drifted and which suffixes are missing.
 *
 * **Known divergence, not asserted here (#252).** Cross-checking `tldts` against an
 * independent implementation of the PSL algorithm (`public_suffix_of` in
 * scripts/qa-gmail-probe.py) over 9,376 hosts found three disagreements, all **nested
 * wildcards**: the list carries both `*.r.cloud.int.apple` and `*.ap-north-1.r.cloud.int.apple`,
 * so the first makes `ap-north-1.r.cloud.int.apple` a public suffix, but `tldts` stops at
 * `int.apple` and reports `cloud.int.apple` as an ownable registrable domain. Left as a
 * report rather than an assertion: it is a divergence between the library and the published
 * list, so asserting it would fail on a correct-for-us build, and the affected names are one
 * vendor's internal cloud infrastructure that will never appear as a mail sender.
 */

import { describe, expect, it } from "vitest";

import { publicSuffix, registrableDomain, sameRegistrableDomain } from "./registrableDomain";

// `packages/core` compiles with `types: []` on purpose — the core is pure and
// provider-agnostic. This manual-tier spec is the one exception, as in
// enforcement/realFilters.analysis.test.ts, so the escape hatch is declared here rather than
// by widening the package's types for all of src.
declare const process: { env: Record<string, string | undefined> };

const CORPUS = process.env.INBOXCLINIC_PSL_CORPUS;

interface PslRule {
  rule: string;
  kind: "normal" | "wildcard" | "exception";
  section: "ICANN" | "PRIVATE";
}

const load = async (): Promise<{ source: string; rules: PslRule[] }> => {
  const mod = (await import(/* @vite-ignore */ CORPUS as string)) as {
    default: { source: string; rules: PslRule[] };
  };
  return mod.default;
};

/**
 * The concrete public suffix a rule denotes.
 *
 * A wildcard `*.ck` is not itself a suffix — it says every `<label>.ck` is one — so it is
 * instantiated with a label to get something testable. An exception `!www.ck` denotes a name
 * that is deliberately NOT a suffix, which is the opposite claim and is checked separately.
 */
function suffixUnderTest(rule: PslRule): string {
  return rule.kind === "wildcard" ? `${LABELS[0]}.${rule.rule.slice(2)}` : rule.rule;
}

/**
 * Labels to hang under a suffix. Deliberately synthetic and hyphenated, and tried in order,
 * because **a plausible label can be a real suffix**: the first version of this spec used
 * `brand`, and reported `se` as drifted — `brand.se` is itself a PSL entry (Sweden's
 * second-level domain for fire brigades), so the composed name resolved to itself rather than
 * to `se`. A hand-picked label silently manufactured a finding, which is the exact failure
 * this replay exists to catch, so the collision is detected rather than hoped away.
 */
const LABELS = ["ic-probe", "zz-probe-9"] as const;

interface Classified {
  /** Rules the bundled snapshot recognises, with a collision-free host to test them by. */
  testable: { suffix: string; host: string; rule: PslRule }[];
  /** Recognised by neither label — the snapshot does not know this suffix. */
  unrecognised: PslRule[];
  /** Every candidate label composed to a name that is ITSELF a suffix. Reported, not tested. */
  collisions: PslRule[];
  /**
   * Single-label suffixes, counted because the drift check is **blind to them**.
   *
   * When no rule matches, the PSL algorithm's prevailing rule is `*`, so an unknown TLD
   * resolves to its last label exactly as a known one does: `publicSuffix("x.zzzznotatld")`
   * is `zzzznotatld`. A missing single-label TLD is therefore indistinguishable from a
   * present one by this method, and only multi-label suffixes (`fake.uk` → `uk`) can be
   * detected as absent. A drift count of zero means "no multi-label suffix is missing", never
   * "the snapshot is current".
   */
  singleLabel: number;
}

/**
 * Split the corpus into what can be asserted and what can only be reported. `tldts` embeds a
 * snapshot of the list that necessarily lags the live one, and a suffix registered last week
 * is not a defect in this code.
 */
function classify(rules: PslRule[]): Classified {
  const out: Classified = { testable: [], unrecognised: [], collisions: [], singleLabel: 0 };
  for (const rule of rules) {
    if (rule.kind === "exception") continue;
    const suffix = suffixUnderTest(rule);
    if (!suffix.includes(".")) out.singleLabel += 1;
    const label = LABELS.find((l) => publicSuffix(`${l}.${suffix}`) === suffix);
    if (label !== undefined) {
      out.testable.push({ suffix, host: `${label}.${suffix}`, rule });
    } else if (LABELS.every((l) => publicSuffix(`${l}.${suffix}`) === `${l}.${suffix}`)) {
      out.collisions.push(rule);
    } else {
      out.unrecognised.push(rule);
    }
  }
  return out;
}

describe.skipIf(CORPUS === undefined)("the live Public Suffix List, replayed (#252)", () => {
  it("reports how far the bundled snapshot has drifted from the live list", async () => {
    const { source, rules } = await load();
    const { testable, unrecognised, collisions, singleLabel } = classify(rules);

    const bySection = (s: string): number => unrecognised.filter((r) => r.section === s).length;
    // Evidence, not a verdict — printed so a run can be pasted into an issue and re-checked
    // after a `tldts` bump, which is when this number should move.
    console.log(
      [
        `PSL corpus: ${String(rules.length)} rules from ${source}`,
        `  asserted over: ${String(testable.length)}`,
        `  unrecognised by the bundled tldts snapshot: ${String(unrecognised.length)}` +
          ` (ICANN ${String(bySection("ICANN"))}, PRIVATE ${String(bySection("PRIVATE"))})`,
        `    ${unrecognised
          .slice(0, 12)
          .map((r) => r.rule)
          .join(", ")}`,
        `  label collided with a real suffix, untestable: ${String(collisions.length)}`,
        `    ${collisions
          .slice(0, 12)
          .map((r) => r.rule)
          .join(", ")}`,
        `  NOT covered by the drift count: ${String(singleLabel)} single-label suffixes —` +
          ` an unknown TLD resolves to its last label exactly as a known one does, so a`,
        `    drift of zero means "no multi-label suffix is missing", never "the snapshot is current".`,
      ].join("\n"),
    );

    // Not an assertion about the counts — only that the corpus was real and the helpers ran
    // over it, so a silently-empty corpus can't read as a clean result.
    expect(rules.length).toBeGreaterThan(1000);
    expect(testable.length).toBeGreaterThan(1000);
  });

  it("never lets a bare public suffix be owned", async () => {
    const { rules } = await load();
    const owned = classify(rules)
      .testable.filter(({ suffix }) => registrableDomain(suffix) !== null)
      .map(({ suffix }) => suffix);

    // A registrable bare suffix would let a parent-domain rule be created over an entire
    // suffix — every tenant of `github.io`, or every `.co.uk` domain in existence. That is
    // the failure Decision 9 names, and #180 would be the deliberate version of it.
    expect(owned).toEqual([]);
  });

  it("keeps one label under a suffix registrable, and distinct labels distinct", async () => {
    const { rules } = await load();
    const wrongRegistrable: string[] = [];
    const collapsed: string[] = [];
    for (const { suffix, host } of classify(rules).testable) {
      if (registrableDomain(host) !== host) wrongRegistrable.push(host);
      // The `x.github.io` / `y.github.io` failure `allowPrivateDomains` exists to prevent:
      // two tenants of one suffix must never resolve to the same organisation, or one
      // tenant's parent-domain rule would cover every other tenant.
      const sibling = `zz-sibling.${suffix}`;
      if (publicSuffix(sibling) === suffix && sameRegistrableDomain(host, sibling)) {
        collapsed.push(suffix);
      }
    }

    expect(wrongRegistrable).toEqual([]);
    expect(collapsed).toEqual([]);
  });

  it("honours the exception rules that claw a name back from a wildcard", async () => {
    const { rules } = await load();
    const exceptions = rules.filter((r) => r.kind === "exception");
    const notClawedBack: string[] = [];
    for (const rule of exceptions) {
      const name = rule.rule.slice(1);
      // `!www.ck` under `*.ck` means `www.ck` IS registrable, where every other `X.ck` is a
      // suffix. Eight rules in the whole list, all inside wildcards, and nothing else in the
      // suite goes near them — a resolver that ignored exceptions would look correct until a
      // sender turned up at exactly one of these names.
      if (registrableDomain(name) !== name) notClawedBack.push(name);
    }

    expect(exceptions.length).toBeGreaterThan(0);
    expect(notClawedBack).toEqual([]);
  });

  it("resolves a subdomain to the same registrable domain as its parent", async () => {
    const { rules } = await load();
    // What a parent-domain rule is built on: everything under `<label>.<suffix>` belongs to
    // `<label>.<suffix>`, however deep.
    const drifted = classify(rules)
      .testable.filter(({ host }) => registrableDomain(`a.b.${host}`) !== host)
      .map(({ host }) => host);

    expect(drifted).toEqual([]);
  });
});
