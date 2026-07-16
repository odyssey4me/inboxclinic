// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

import { gotoDemo } from "./helpers";

test("decisions view: change a block to trust with a previewed, confirmed re-decision", async ({
  page,
}) => {
  await gotoDemo(page);

  await page.getByRole("button", { name: /^Decisions$/ }).click();
  await expect(page.getByRole("heading", { name: /^Decisions$/ })).toBeVisible();

  // The seeded demo blocks deals@retailco.com — change it to Trust.
  const row = page.getByRole("listitem").filter({ hasText: "deals@retailco.com" });
  await row.getByRole("button", { name: /change to trust/i }).click();

  // A confirm dialog with the read-only impact preview appears; apply it.
  await expect(page.getByRole("alertdialog", { name: /confirm decision change/i })).toBeVisible();
  await expect(page.getByText(/when you apply/i)).toBeVisible();
  await page.getByRole("button", { name: /confirm & apply/i }).click();

  await expect(page.getByText(/deals@retailco\.com is now trusted/i)).toBeVisible();
});

test("decisions view: import prior decisions learned from Gmail (Spam/Trash)", async ({ page }) => {
  await gotoDemo(page);
  await page.getByRole("button", { name: /^Decisions$/ }).click();

  // Learned from the demo's Spam/Trash: a confirm-first import appears, pre-selected
  // per suggestion (each can be blocked by address, by domain, or skipped).
  await expect(page.getByRole("heading", { name: /found \d+ prior decision/i })).toBeVisible();
  await page.getByRole("button", { name: /import selected as blocked/i }).click();

  await expect(page.getByText(/imported \d+ prior decision/i)).toBeVisible();
  // The imported spam sender is now a blocked decision in the list.
  await expect(
    page.getByRole("listitem").filter({ hasText: "wins@megacasino.example" }),
  ).toBeVisible();
});
