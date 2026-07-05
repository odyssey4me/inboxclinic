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

test("dashboard: explore domains and act on a whole domain", async ({ page }) => {
  await gotoDemo(page);

  // Switch the list to Domains, open a domain that has multiple senders. Scope the click
  // to the Domains region and match exactly so it can't hit a sender address like
  // news@retailco.com (which also contains "retailco.com").
  await page.getByRole("tab", { name: /domains/i }).click();
  const domainsRegion = page.getByRole("region", { name: "Domains" });
  await domainsRegion.getByText("retailco.com", { exact: true }).first().click();

  const drawer = page.getByRole("dialog", { name: /actions for retailco\.com/i });
  await expect(drawer).toBeVisible();

  // Trusting the domain applies in place and closes the drawer.
  await drawer.getByRole("button", { name: /trust domain/i }).click();
  await expect(drawer).toBeHidden();
});
