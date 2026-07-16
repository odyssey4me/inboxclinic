// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

import { gotoDemo } from "./helpers";

test("trust workflow: Triage → Review → Execution", async ({ page }) => {
  await gotoDemo(page);

  // Enter the workflow from the dashboard's pending decisions.
  await page.getByRole("button", { name: /triage \d+ pending/i }).click();

  // Triage: actions are inline — trust the current sender in one tap.
  await page.getByRole("button", { name: /^Trust$/ }).click();

  // A staged change is now reviewable; open Review and apply it.
  await page.getByRole("button", { name: /review \d+ change/i }).click();
  await expect(page.getByText(/1 trusted/i)).toBeVisible();
  await page.getByRole("button", { name: /apply changes/i }).click();

  // Execution runs against the in-memory Gmail client and completes.
  await expect(page.getByText(/done —/i)).toBeVisible();
  await page.getByRole("button", { name: /^Done$/ }).click();

  // Back on the home decisions surface.
  await expect(page.getByRole("heading", { name: /^Decisions$/ })).toBeVisible();
});

test("block workflow: stage a block with actions", async ({ page }) => {
  await gotoDemo(page);

  await page.getByRole("button", { name: /triage \d+ pending/i }).click();

  // Block in one tap (smart defaults staged; the impact preview shows before applying).
  await page.getByRole("button", { name: /^Block$/ }).click();

  await page.getByRole("button", { name: /review \d+ change/i }).click();
  await expect(page.getByText(/1 blocked/i)).toBeVisible();
  // The impact preview dry-runs the change before it is applied.
  await expect(page.getByText(/when you apply/i)).toBeVisible();
  await page.getByRole("button", { name: /apply changes/i }).click();
  await expect(page.getByText(/done —/i)).toBeVisible();
});
