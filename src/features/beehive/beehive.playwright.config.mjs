import { defineConfig } from "@playwright/test";

// Focused offline iteration. The ordinary browser lanes run the same journey
// through tests/browser/beehive.spec.mjs.
export default defineConfig({
  testDir: ".",
  testMatch: "beehive.journey.mjs",
  globalSetup: "../../../tests/browser/vite-server.mjs",
  outputDir: "../../../test-results/beehive",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    headless: true,
    actionTimeout: 5_000,
    viewport: { width: 1000, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: ["chromium", "webkit"].map((browserName) => ({
    name: browserName,
    use: { browserName },
  })),
});
