import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./src/scan/tests",
  fullyParallel: false,
  retries: 0,
  workers: 2,
  reporter: [
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["list"],
  ],
  use: {
    baseURL: process.env.TARGET_FRONTEND_URL ?? "http://localhost:5173",
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
