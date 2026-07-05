// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

import { gotoDemo, revealLayoutSwitch } from "./helpers";

test("layout switch pins the desktop (sidebar) and mobile shells", async ({ page }, testInfo) => {
  // The desktop layout needs desktop width. On a real phone, pinning Desktop widens the
  // viewport (meta width=1024) so the browser zooms out; Playwright's fixed device
  // viewport can't emulate that, so this switch test only runs at desktop width.
  test.skip(testInfo.project.name === "mobile", "layout switch requires desktop width");

  await gotoDemo(page);

  // Pin Desktop → the sidebar (a complementary landmark) appears.
  await revealLayoutSwitch(page);
  await page.getByRole("button", { name: "Desktop" }).click();
  await expect(page.getByRole("complementary")).toBeVisible();

  // Pin Mobile → the single-column shell has no sidebar.
  await page.getByRole("button", { name: "Mobile" }).click();
  await expect(page.getByRole("complementary")).toHaveCount(0);
});
