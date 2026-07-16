// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

import { gotoDemo } from "./helpers";

test("routing: navigating updates the URL and the back button returns", async ({ page }) => {
  await gotoDemo(page); // lands at /?demo=1
  await expect(page).toHaveURL(/\/\?demo=1$/);

  await page.getByRole("button", { name: "Analytics" }).click();
  await expect(page).toHaveURL(/\/analytics\?demo=1$/);

  await page.goBack();
  await expect(page).toHaveURL(/\/\?demo=1$/);
  await expect(page.getByRole("heading", { name: /^Decisions$/ })).toBeVisible();
});

test("routing: a deep link opens the target screen directly (SPA fallback)", async ({ page }) => {
  // Cloudflare Pages' _redirects serves index.html for any path; the app resolves the route.
  await page.goto("/settings?demo=1");
  await expect(page.getByRole("button", { name: /rescan inbox/i })).toBeVisible();
});
