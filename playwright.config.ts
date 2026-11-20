import { defineConfig, devices } from "@playwright/test";

const apiUrl = "http://localhost:4100";
const build = "node tests/playwright/prepare.mjs";
const env = { NEXT_PUBLIC_API_URL: apiUrl, NEXT_TELEMETRY_DISABLED: "1" };

export default defineConfig({
  testDir: "tests/playwright",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    trace: "retain-on-failure",
  },
  projects: [
    { name: "checkout", testMatch: /checkout\.spec\.ts/, use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:3100" } },
    { name: "merchant", testMatch: /merchant\.spec\.ts/, use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:3101" } },
    { name: "admin", testMatch: /admin\.spec\.ts/, use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:3102" } },
  ],
  webServer: [
    {
      // The Next dev server resolves workspace packages from their dist output,
      // so a fresh checkout must build the apps' dependencies first.
      command: `${build} && pnpm --filter @wpay/web exec next dev -p 3100`,
      url: "http://localhost:3100",
      timeout: 300_000,
      reuseExistingServer: !process.env.CI,
      env,
    },
    {
      command: `${build} && pnpm --filter @wpay/merchant-dashboard exec next dev -p 3101`,
      url: "http://localhost:3101",
      timeout: 300_000,
      reuseExistingServer: !process.env.CI,
      env,
    },
    {
      command: `${build} && pnpm --filter @wpay/admin-dashboard exec next dev -p 3102`,
      url: "http://localhost:3102",
      timeout: 300_000,
      reuseExistingServer: !process.env.CI,
      env,
    },
  ],
});
