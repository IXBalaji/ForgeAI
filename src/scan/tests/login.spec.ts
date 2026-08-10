import { test, expect } from "@playwright/test";
import { runAxeScan, AXE_TAGS } from "./helpers/axe.js";
import { USERS } from "./fixtures/users.js";

test.describe("Login page", () => {
  test("full accessibility scan of the sign-in form", async ({ page }, testInfo) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();

    await runAxeScan(page, testInfo, {
      label: "Login page (initial state)",
      fileSlug: "login-initial",
      tags: AXE_TAGS,
    });
  });

  test("client-side validation errors are announced and remain accessible", async ({ page }, testInfo) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByText("Enter your work email.")).toBeVisible();
    await expect(page.getByText("Enter your password.")).toBeVisible();

    await runAxeScan(page, testInfo, {
      label: "Login page (validation errors)",
      fileSlug: "login-validation-errors",
      tags: AXE_TAGS,
    });
  });

  test("failed login shows an alert and stays accessible", async ({ page }, testInfo) => {
    await page.goto("/login");
    await page.getByLabel("Work email").fill(USERS.employee.email);
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("alert")).toBeVisible();

    await runAxeScan(page, testInfo, {
      label: "Login page (failed login alert)",
      fileSlug: "login-failed-alert",
      tags: AXE_TAGS,
    });
  });
});
