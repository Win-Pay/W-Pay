import { defineConfig, devices } from "@playwright/test";

/**
 * Opt-in end-to-end suite that drives the real Freighter (Varial) browser
 * extension against a running local/Testnet stack. It is intentionally not
 * part of `playwright.config.ts`: it needs the unpacked extension, a funded
 * Testnet wallet (created by the test), and a disposable Testnet invoice.
 *
 * No webServer is configured. Start the API with Testnet contract IDs and the
 * checkout app yourself, or use `.github/workflows/freighter-e2e.yml`.
 */
export default defineConfig({
  testDir: "tests/freighter",
  timeout: 300_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report/freighter", open: "never" }]],
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
