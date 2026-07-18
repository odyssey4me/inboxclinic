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

test("decisions surface: no standalone prior-decisions import card (folded into scoring)", async ({
  page,
}) => {
  await gotoDemo(page);
  // The "Import all as Blocked" card was removed (#96) — prior-block signals now fold into the
  // trust score and the detail panel instead.
  await expect(page.getByRole("button", { name: /import all as blocked/i })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /^Decisions$/ })).toBeVisible();
});

test("decisions surface: consolidate same-domain flagged siblings from the detail panel (#96, #128)", async ({
  page,
}) => {
  await gotoDemo(page);

  // deals@bargainhub.example has two same-domain siblings that are still pending but already
  // binned unread (a prior-block signal, learned on mount) — opening it offers to decide all
  // three together.
  await page.getByRole("searchbox", { name: /search senders/i }).fill("bargainhub");
  await page.getByText("deals@bargainhub.example").first().click();

  const drawer = page.getByRole("dialog", { name: /actions for deals@bargainhub\.example/i });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(/2 other flagged senders on bargainhub\.example/i)).toBeVisible();

  // "Keep all" trusts the opened sender and both siblings in one step.
  await drawer.getByRole("button", { name: /keep all/i }).click();
  await expect(drawer).toBeHidden();

  await page.getByRole("tab", { name: /^all/i }).click();
  for (const email of [
    "deals@bargainhub.example",
    "offers@bargainhub.example",
    "news@bargainhub.example",
  ]) {
    const item = page.locator("tr, li").filter({ hasText: email });
    await expect(item).toContainText("trusted");
  }
});
