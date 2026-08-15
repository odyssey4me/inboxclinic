// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

import { gotoDemo } from "./helpers";

test("Settings: back up to Drive, then restore", async ({ page }) => {
  await gotoDemo(page);

  await page.getByRole("button", { name: /^Settings$/ }).click();

  // Backup is on by default and needs no consent step (design-backup-restore.md D2).
  await expect(page.getByRole("checkbox", { name: /enable google drive backup/i })).toBeChecked();

  // Back up now.
  await page.getByRole("button", { name: /back up now/i }).click();
  await expect(page.getByText(/in your drive/i)).toBeVisible();

  // Restore, confirming the replace-local warning.
  await page.getByRole("button", { name: /restore from backup/i }).click();
  await page.getByRole("button", { name: /replace local data/i }).click();
  await expect(page.getByText(/restore complete/i)).toBeVisible();
});
