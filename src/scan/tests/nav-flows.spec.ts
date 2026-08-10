import { test, expect } from "@playwright/test";
import { runAxeScan, AXE_TAGS } from "./helpers/axe.js";
import { authFile, gotoAuthed } from "./helpers/auth.js";

test.describe("Navigation flows", () => {
  test.use({ storageState: authFile("employee") });

  test("mobile nav toggle opens and closes the primary menu", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 480, height: 800 });
    await gotoAuthed(page);

    const toggle = page.getByRole("button", { name: "Toggle navigation menu" });
    const nav = page.getByRole("navigation", { name: "Primary" });

    await expect(nav).toBeHidden();
    await toggle.click();
    await expect(nav).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    await runAxeScan(page, testInfo, {
      label: "Primary nav open (mobile viewport)",
      fileSlug: "nav-mobile-open",
      tags: AXE_TAGS,
    });

    await toggle.click();
    await expect(nav).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  test("sign out returns to the login page", async ({ page }, testInfo) => {
    await gotoAuthed(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();

    await runAxeScan(page, testInfo, {
      label: "Login page (after sign out)",
      fileSlug: "nav-signed-out",
      tags: AXE_TAGS,
    });
  });
});
