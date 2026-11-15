import { defineConfig } from "@playwright/test";

// Runs against a real `buzz-hive`, so it is not part of the ordinary browser
// lanes. See engine.mjs for the environment it needs.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.mjs",
  globalSetup: "../../../../tests/browser/vite-server.mjs",
  outputDir: "../../../../test-results/beehive-e2e",
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  use: { headless: true, viewport: { width: 1000, height: 900 } },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
