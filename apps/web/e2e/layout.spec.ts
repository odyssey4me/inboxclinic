// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

import { gotoDemo, revealLayoutSwitch } from "./helpers";

test("layout switch pins the desktop (sidebar) and mobile shells", async ({ page }) => {
  await gotoDemo(page);

  // Pin Desktop → the sidebar (a complementary landmark) appears.
  await revealLayoutSwitch(page);
  await page.getByRole("button", { name: "Desktop" }).click();
  await expect(page.getByRole("complementary")).toBeVisible();

  // Pin Mobile → the single-column shell has no sidebar.
  await page.getByRole("button", { name: "Mobile" }).click();
  await expect(page.getByRole("complementary")).toHaveCount(0);
});
