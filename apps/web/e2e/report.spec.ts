// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

import { gotoDemo } from "./helpers";

test("global Feedback drawer shows the redacted, no-backend payload", async ({ page }) => {
  await gotoDemo(page);

  // The app advertises alpha and offers feedback from anywhere via the header.
  await expect(page.getByText("Alpha", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Feedback" }).click();

  const drawer = page.getByRole("dialog", { name: /send feedback/i });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(/exactly what will be sent/i)).toBeVisible();
  await expect(drawer.getByRole("button", { name: /^Copy$/ })).toBeVisible();
  await expect(drawer.getByRole("button", { name: /^Download$/ })).toBeVisible();
  // Without a Turnstile site key configured, submission is not offered.
  await expect(drawer.getByRole("button", { name: /send report/i })).toHaveCount(0);
});
