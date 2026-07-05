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
