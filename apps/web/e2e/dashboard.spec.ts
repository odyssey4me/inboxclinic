// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

import { gotoDemo } from "./helpers";

test("dashboard: act on a sender directly from the detail drawer", async ({ page }) => {
  await gotoDemo(page);

  // Clicking a sender (row on desktop, card on mobile) opens its detail drawer.
  await page.getByText("news@retailco.com").first().click();
  const drawer = page.getByRole("dialog", { name: /actions for news@retailco\.com/i });
  await expect(drawer).toBeVisible();

  // Trust applies in place and closes the drawer.
  await drawer.getByRole("button", { name: /^Trust$/ }).click();
  await expect(drawer).toBeHidden();
});
