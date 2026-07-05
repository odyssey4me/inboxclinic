// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

import { gotoDemo } from "./helpers";

test("Settings: open the report panel and see the redacted, no-backend payload", async ({
  page,
}) => {
  await gotoDemo(page);

  await page.getByRole("button", { name: /^Settings$/ }).click();
  await page.getByRole("button", { name: /^Report a problem$/ }).click();

  // The transparent preview and the no-backend actions are present.
  await expect(page.getByText(/exactly what will be sent/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Copy$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Download$/ })).toBeVisible();
  // Without a Turnstile site key configured, submission is not offered.
  await expect(page.getByRole("button", { name: /send report/i })).toHaveCount(0);
});
