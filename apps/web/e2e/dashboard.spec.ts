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

test("dashboard: act on a whole domain from a sender's detail panel", async ({ page }) => {
  await gotoDemo(page);

  // Whole-domain decisions live on the sender's detail panel (scope toggle). Open a pending
  // sender whose domain has siblings (news@ + deals@ on retailco.com).
  await page.getByText("news@retailco.com").first().click();
  const drawer = page.getByRole("dialog", { name: /actions for news@retailco\.com/i });
  await expect(drawer).toBeVisible();

  // Switch the decision scope to the whole domain, then Trust it in place.
  await drawer.getByRole("radio", { name: /whole domain/i }).check();
  await drawer.getByRole("button", { name: /^Trust$/ }).click();
  await expect(drawer).toBeHidden();
});

test("dashboard: group by domain and act on a whole domain", async ({ page }) => {
  await gotoDemo(page);

  // Toggle the surface to domain aggregates, then open a multi-sender domain.
  await page.getByRole("checkbox", { name: /group by domain/i }).check();
  await page.getByText("retailco.com", { exact: true }).first().click();

  const drawer = page.getByRole("dialog", { name: /actions for retailco\.com/i });
  await expect(drawer).toBeVisible();

  // Trusting the domain applies to all its members in place and closes the drawer.
  await drawer.getByRole("button", { name: /trust domain/i }).click();
  await expect(drawer).toBeHidden();
});
