// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

import { gotoDemo } from "./helpers";

test("Settings: check and apply filter optimisations", async ({ page }) => {
  await gotoDemo(page);

  await page.getByRole("button", { name: /^Settings$/ }).click();
  await page.getByRole("button", { name: /check my filters/i }).click();

  // The demo's messy app-created filters yield a consolidation suggestion.
  await expect(page.getByText(/combine .*oldshop\.example.*rule/i)).toBeVisible();

  // ...but the equally messy filters the user built by hand are never offered (#190).
  await expect(page.getByText(/receipts\.example/i)).toHaveCount(0);

  await page.getByRole("button", { name: /apply \d+ change/i }).click();
  await expect(page.getByText(/tidied your filters/i)).toBeVisible();
});
