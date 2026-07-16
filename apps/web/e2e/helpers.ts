// SPDX-License-Identifier: Apache-2.0
import { expect, type Page } from "@playwright/test";

/** The seeded demo identity (matches `@inboxclinic/core/demo`'s DEMO_ACCOUNT_EMAIL). */
export const DEMO_EMAIL = "demo.user@inboxclinic.app";

/** Open the app straight into demo mode and wait for the demo banner. */
export async function gotoDemo(page: Page): Promise<void> {
  await page.goto("/?demo=1");
  await expect(page.getByText(/demo mode/i)).toBeVisible();
}

/**
 * Make the layout switch reachable. It lives inside the account menu in both shells — a
 * sidebar-foot disclosure on desktop, a header disclosure on mobile — which must be opened.
 */
export async function revealLayoutSwitch(page: Page): Promise<void> {
  const auto = page.getByRole("button", { name: "Auto" });
  if (!(await auto.isVisible().catch(() => false))) {
    await page.locator("summary").first().click();
  }
}
