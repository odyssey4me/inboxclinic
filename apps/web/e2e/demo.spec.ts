// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

import { DEMO_EMAIL } from "./helpers";

test("landing offers a demo that opens a populated dashboard, and can exit", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /explore the demo/i }).click();

  // Signed in as the demo identity with a clear demo banner — no Google sign-in.
  // (The mobile shell shows the email in both the account summary and its panel.)
  await expect(page.getByText(/demo mode/i)).toBeVisible();
  await expect(page.getByText(DEMO_EMAIL).first()).toBeVisible();

  // The decisions surface is populated from the seeded store. It opens on Pending; switch
  // to All to see the seeded decided senders (jane trusted, deals blocked).
  await page.getByRole("tab", { name: /^all/i }).click();
  await expect(page.getByText("jane.cooper@gmail.com").first()).toBeVisible();
  await expect(page.getByText("deals@retailco.com").first()).toBeVisible();

  // Exiting returns to the signed-out landing page.
  await page.getByRole("button", { name: /exit demo/i }).click();
  await expect(page.getByRole("button", { name: /sign in with google/i })).toBeVisible();
});
