/**
 * Playwright config for the browser acceptance harness.
 *
 * One real chromium browser drives the built SPA against the full compose
 * stack (see global-setup.ts). A single worker runs the specs serially: the
 * stack has ONE control-plane + ONE agent worker and enforces one run per
 * session (409 session_busy), so parallel specs would contend. Traces are
 * retained on failure for post-mortem; there are no arbitrary sleeps in the
 * specs — every wait polls a real UI state.
 *
 * Spec files are named `*.e2e.ts` (not `*.spec.ts`/`*.test.ts`) so the repo's
 * `bun test` runner never tries to execute them.
 */
import { defineConfig, devices } from "@playwright/test";

import { PREVIEW_URL } from "./config.ts";

export default defineConfig({
  testDir: "./specs",
  testMatch: /.*\.e2e\.ts/,
  // A fresh eve build (minutes) plus a cold agent boot + run happen inside one
  // acceptance test — give the whole story generous room.
  timeout: 30 * 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }], ["github"]]
    : [["list"], ["html", { open: "never" }]],
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  outputDir: "./.artifacts/test-results",
  use: {
    baseURL: PREVIEW_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "acceptance",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
