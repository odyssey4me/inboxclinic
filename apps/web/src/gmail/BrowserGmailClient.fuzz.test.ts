// SPDX-License-Identifier: Apache-2.0
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseHeaders } from "./BrowserGmailClient";

// `parseHeaders` consumes the `payload.headers` array from an unchecked `JSON.parse` of the Gmail
// API response — untrusted input. It must never throw and must only ever emit allowlisted,
// string-valued metadata (never a message body). See docs/design-testing.md (Fuzzing) and #166.

const headerEntry = fc.oneof(
  fc.record({ name: fc.string(), value: fc.string() }),
  fc.record({ name: fc.string() }), // missing value
  fc.record({ value: fc.string() }), // missing name
  fc.anything(), // numbers, null, arrays, nested objects — anything a bad response might carry
);

describe("parseHeaders — fuzzing untrusted Gmail response headers (#166)", () => {
  it("never throws and only emits string-valued metadata for arbitrary header arrays", () => {
    fc.assert(
      fc.property(fc.array(headerEntry, { maxLength: 30 }), (headers) => {
        const result = parseHeaders(headers as never);
        for (const value of Object.values(result)) expect(typeof value).toBe("string");
      }),
    );
  });

  it("tolerates non-array input without throwing", () => {
    for (const bad of [undefined, null, "string", 42, {}, Symbol("x")]) {
      expect(() => parseHeaders(bad as never)).not.toThrow();
    }
  });

  it("maps allowlisted headers, ignores prototype-named headers, and never pollutes the prototype", () => {
    const result = parseHeaders([
      { name: "From", value: "a@b.com" },
      { name: "List-Unsubscribe", value: "<https://u>" },
      { name: "__proto__", value: "polluted" },
      { name: "constructor", value: "polluted" },
      { name: "toString", value: "polluted" },
      { name: "X-Unknown-Header", value: "ignored" },
    ]);
    expect(result.from).toBe("a@b.com");
    expect(result.listUnsubscribe).toBe("<https://u>");
    // No inherited-property key bled into the result, and Object.prototype is untouched.
    expect(Object.values(result)).not.toContain("polluted");
    expect(Object.values(result)).not.toContain("ignored");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
