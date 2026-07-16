// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

import { gotoDemo } from "./helpers";

test("decisions surface: re-decide a trusted sender to blocked, previewed and confirmed", async ({
  page,
}) => {
  await gotoDemo(page);

  // The home is the decisions surface; the nav item confirms it.
  await page.getByRole("button", { name: /^Decisions$/ }).click();
  await expect(page.getByRole("heading", { name: /^Decisions$/ })).toBeVisible();

  // jane.cooper is seeded trusted — view decided senders and change her to Blocked.
  await page.getByRole("tab", { name: /^decided/i }).click();
  // Layout-agnostic: the per-sender action group is labelled identically on the desktop
  // table row and the mobile card.
  await page
    .getByRole("group", { name: /decide jane\.cooper@gmail\.com/i })
    .getByRole("button", { name: /^Block$/ })
    .click();

  // Block opens the detail panel, where the impact is previewed before it applies.
  const drawer = page.getByRole("dialog", { name: /actions for jane\.cooper@gmail\.com/i });
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: /^Block$/ }).click();
  await expect(drawer.getByText(/when you apply/i)).toBeVisible();
  await drawer.getByRole("button", { name: /confirm block/i }).click();
  await expect(drawer).toBeHidden();

  // The re-decision is reflected in the sender's row/card status.
  const janeItem = page.locator("tr, li").filter({ hasText: "jane.cooper@gmail.com" });
  await expect(janeItem).toContainText("blocked");
});

test("decisions surface: import prior decisions learned from Gmail (Spam/Trash)", async ({
  page,
}) => {
  await gotoDemo(page);

  // Learned from the demo's Spam/Trash, the prior-decisions card surfaces on the home.
  await expect(page.getByRole("heading", { name: /found \d+ prior decision/i })).toBeVisible();
  await page.getByRole("button", { name: /import all as blocked/i }).click();
  await expect(page.getByText(/imported \d+ prior decision/i)).toBeVisible();

  // The imported spam sender is now a blocked decision — find it via search on the All tab.
  await page.getByRole("tab", { name: /^all/i }).click();
  await page.getByRole("searchbox", { name: /search senders/i }).fill("megacasino");
  await expect(page.getByText("wins@megacasino.example")).toBeVisible();
});
