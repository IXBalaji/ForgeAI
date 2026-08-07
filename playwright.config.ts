import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/scan",
  fullyParallel: false,
  retries: 0,
  workers: 2,
  reporter: [
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["list"],
  ],
  use: {
    baseURL: process.env.TARGET_FRONTEND_URL ?? "https://ashy-desert-0ae520400.7.azurestaticapps.net",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
      testIgnore: /auth\.setup\.ts/,
      dependencies: ["setup"],
    },
  ],
});
