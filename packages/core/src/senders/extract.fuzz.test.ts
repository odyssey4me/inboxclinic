// SPDX-License-Identifier: Apache-2.0
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { extractSenders, parseAuthResults, parseFromHeader } from "./extract";
import { messageMetaBuilder } from "../testing";

// The `From` / auth-results headers are untrusted (from an unchecked Gmail API response), so these
// parsers must never throw on garbage and must only ever emit metadata (never message content).
// See docs/design-testing.md (Decision 8, Fuzzing) and #166.

const maybeString = fc.option(fc.string(), { nil: undefined });

describe("Gmail header parsing — fuzzing (#166)", () => {
  it("parseFromHeader: any input yields null or a well-formed address, never throws", () => {
    fc.assert(
      fc.property(maybeString, (raw) => {
        const parsed = parseFromHeader(raw);
        if (parsed !== null) {
          expect(parsed.email).toContain("@");
          expect(parsed.email).toBe(parsed.email.toLowerCase());
          expect(parsed.domain).toContain(".");
          expect(parsed.email.endsWith(`@${parsed.domain}`)).toBe(true);
          expect(parsed.displayName === null || typeof parsed.displayName === "string").toBe(true);
        }
      }),
    );
  });

  it("parseAuthResults: any input yields four booleans, never throws", () => {
    fc.assert(
      fc.property(maybeString, (raw) => {
        const r = parseAuthResults(raw);
        for (const v of [r.spf, r.dkim, r.dmarc, r.spoofed]) expect(typeof v).toBe("boolean");
      }),
    );
  });

  it("extractSenders: arbitrary header metadata never throws and stays metadata-only", () => {
    // Keys are randomly present-or-absent (never explicit `undefined`, for exactOptionalPropertyTypes);
    // absent `from` falls back to the builder default, present values are arbitrary garbage strings.
    const headers = fc.record(
      {
        from: fc.string(),
        listUnsubscribe: fc.string(),
        listId: fc.string(),
        authenticationResults: fc.string(),
        subject: fc.string(),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(fc.array(headers, { maxLength: 20 }), (headersList) => {
        const metas = headersList.map((h) => messageMetaBuilder({ headers: h }));
        const { senders, domains } = extractSenders(metas, 1_700_000_000_000);
        // Never invents a sender beyond the inputs.
        expect(senders.length).toBeLessThanOrEqual(metas.length);
        for (const s of senders) {
          expect(s.email).toContain("@");
          expect(s.domain).toContain(".");
          // Metadata-only: the derived Sender carries no message body / content field.
          expect(s).not.toHaveProperty("body");
          expect(s).not.toHaveProperty("snippet");
        }
        for (const d of domains) expect(d.domain).toContain(".");
      }),
    );
  });
});
