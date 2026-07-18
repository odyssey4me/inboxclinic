// SPDX-License-Identifier: Apache-2.0
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { InvalidBackupError, parseStoreDump, STORE_DUMP_TABLES } from "./parseStoreDump";
import { createInMemoryStore, senderBuilder } from "../testing";

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("parseStoreDump — fuzzing the restore/import boundary (#166)", () => {
  it("on ANY bytes: returns a valid dump or throws InvalidBackupError — never any other error", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (bytes) => {
        try {
          const dump = parseStoreDump(bytes);
          for (const table of STORE_DUMP_TABLES) expect(Array.isArray(dump[table])).toBe(true);
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidBackupError);
        }
      }),
    );
  });

  it("on ANY JSON value: same invariant (exercises the parses-but-wrong-shape space)", () => {
    fc.assert(
      fc.property(fc.json(), (json) => {
        try {
          const dump = parseStoreDump(encode(json));
          for (const table of STORE_DUMP_TABLES) expect(Array.isArray(dump[table])).toBe(true);
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidBackupError);
        }
      }),
    );
  });

  // Hand-picked hostile inputs — each must reject with the typed error, never a raw throw.
  it.each([
    ["empty", ""],
    ["truncated object", "{"],
    ["a JSON array", "[]"],
    ["a JSON string", '"nope"'],
    ["a bare number", "42"],
    ["a bare null", "null"],
    ["a table that isn't an array", '{"senders":"oops"}'],
    ["a table with a primitive row", '{"senders":[1,2,3]}'],
    ["a table with an array row", '{"senders":[[]]}'],
    ["a table with a null row", '{"senders":[null]}'],
  ])("rejects %s with InvalidBackupError", (_label, text) => {
    expect(() => parseStoreDump(encode(text))).toThrow(InvalidBackupError);
  });

  it("rejects non-UTF-8 bytes without throwing a raw decode error", () => {
    expect(() => parseStoreDump(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow(InvalidBackupError);
  });

  it("does not pollute Object.prototype via a __proto__ key, and yields an empty dump", () => {
    const dump = parseStoreDump(encode('{"__proto__":{"polluted":true}}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    for (const table of STORE_DUMP_TABLES) expect(dump[table]).toEqual([]);
  });

  it("round-trips a real exportAll dump", async () => {
    const store = createInMemoryStore();
    await store.senders.bulkPut([senderBuilder("a@x.com"), senderBuilder("b@y.com")]);
    const dump = parseStoreDump(await store.exportAll());
    expect(dump.senders.map((s) => s.email).sort()).toEqual(["a@x.com", "b@y.com"]);
    expect(dump.prompts).toEqual([]);
  });

  it("leaves the store UNCHANGED on a malformed restore blob (no partial write / wipe)", async () => {
    const malformed = ["not json at all", "{", "[]", '{"senders":"oops"}', '{"senders":[42]}'];
    for (const text of malformed) {
      const store = createInMemoryStore();
      await store.senders.bulkPut([senderBuilder("keep@x.com")]);
      const before = await store.exportAll();
      await expect(store.importAll(encode(text))).rejects.toBeInstanceOf(InvalidBackupError);
      // The seeded sender survives — the store was never wiped.
      expect(await store.exportAll()).toEqual(before);
    }
  });
});
