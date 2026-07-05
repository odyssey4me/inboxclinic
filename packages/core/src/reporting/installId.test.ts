// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { createInMemoryStore } from "../testing";
import { getInstallId, INSTALL_ID_KEY, resetInstallId } from "./installId";

describe("install ID", () => {
  it("mints a stable id on first use and returns the same one thereafter", async () => {
    const store = createInMemoryStore();
    const first = await getInstallId(store);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await getInstallId(store)).toBe(first);
  });

  it("resets to a different id", async () => {
    const store = createInMemoryStore();
    const first = await getInstallId(store);
    const next = await resetInstallId(store);
    expect(next).not.toBe(first);
    expect(await getInstallId(store)).toBe(next);
  });

  it("rides along in export/import (backup) so an honest install stays stable", async () => {
    const source = createInMemoryStore();
    const id = await getInstallId(source);
    const blob = await source.exportAll();

    const restored = createInMemoryStore();
    await restored.importAll(blob);
    expect(await getInstallId(restored)).toBe(id);
    expect((await restored.settings.get(INSTALL_ID_KEY))?.value).toBe(id);
  });
});
