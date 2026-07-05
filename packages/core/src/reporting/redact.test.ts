// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { redact } from "./redact";

describe("redact", () => {
  it("masks a Gmail message id in a REST path but keeps header names", () => {
    const input =
      "Gmail API responded 429 for /messages/19efa38b32b35328?format=metadata" +
      "&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date";
    const out = redact(input);
    expect(out).toContain("/messages/[id]?format=metadata");
    // Header *names* are not sensitive — keep them.
    expect(out).toContain("metadataHeaders=From");
    expect(out).toContain("metadataHeaders=Subject");
    expect(out).not.toContain("19efa38b32b35328");
  });

  it("does not mask non-id path segments like batchModify", () => {
    expect(redact("POST /messages/batchModify")).toBe("POST /messages/batchModify");
  });

  it("masks thread ids too", () => {
    expect(redact("/threads/18ab34cd56ef7890 failed")).toBe("/threads/[id] failed");
  });

  it("masks email addresses", () => {
    expect(redact("from:news@retailco.com bounced")).toBe("from:[email] bounced");
  });

  it("masks bearer and ya29 tokens", () => {
    expect(redact("Authorization: Bearer ya29.a0ARrdaM-xyz_123")).toContain("Bearer [token]");
    expect(redact("token ya29.a0ARrdaM-xyz_123 expired")).toBe("token [token] expired");
  });

  it("masks token query/JSON values", () => {
    expect(redact("?access_token=abc.def-123&x=1")).toBe("?access_token=[token]&x=1");
    expect(redact('{"refresh_token":"secretvalue"}')).toContain("refresh_token=[token]");
  });

  it("masks subject values (param and header) but not the word in a header name", () => {
    expect(redact("&subject=Your%20receipt&y=2")).toBe("&subject=[subject]&y=2");
    expect(redact("Subject: Invoice #42")).toBe("Subject: [subject]");
    expect(redact("metadataHeaders=Subject")).toBe("metadataHeaders=Subject");
  });

  it("is safe on empty/undefined", () => {
    expect(redact(undefined)).toBe("");
    expect(redact("")).toBe("");
  });

  it("leaves a benign message unchanged", () => {
    expect(redact("Network request failed")).toBe("Network request failed");
  });
});
