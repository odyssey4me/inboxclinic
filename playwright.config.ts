// SPDX-License-Identifier: Apache-2.0
// Tier-3 end-to-end tests (docs/design-testing.md Decision 7). Playwright drives the
// built app through its no-Google **demo mode** (?demo) across chromium, firefox, webkit,
// and a mobile viewport. No Google, no network — the demo store is ephemeral and in-memory.
import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
const baseURL = `http://localhost:${PORT}`;
const isCI = process.env.CI !== undefined && process.env.CI !== "";

export default defineConfig({
  testDir: "./apps/web/e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  // `fullyParallel` parallelises tests *within* a file; independently, CI pins to a
  // single worker (process) for deterministic, resource-stable runs, while locally we
  // let Playwright pick the worker count.
  workers: isCI ? 1 : undefined,
  reporter: isCI ? [["html", { open: "never" }], ["list"]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  // Build the app and serve the production bundle; demo mode needs no env vars.
  webServer: {
    command: `npm run build --workspace apps/web && npm run preview --workspace apps/web -- --port ${PORT} --strictPort`,
    url: baseURL,
    reuseExistingServer: !isCI,
    timeout: 180_000,
  },
});
