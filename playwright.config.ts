import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  reporter: "list",
  use: {
    ...devices["Pixel 7"],
    baseURL: "http://localhost:8000",
    serviceWorkers: "block",
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  webServer: {
    command: "node scripts/serve.mjs",
    url: "http://localhost:8000/",
    reuseExistingServer: !process.env.CI,
  },
});
