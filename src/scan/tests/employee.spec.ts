import { test, expect } from "@playwright/test";
import { runAxeScan, AXE_TAGS } from "./helpers/axe.js";
import { authFile, gotoAuthed, goToNavLink } from "./helpers/auth.js";

test.describe("Employee role", () => {
  test.use({ storageState: authFile("employee") });

  test.beforeEach(async ({ page }) => {
    await gotoAuthed(page);
  });

  test("dashboard", async ({ page }, testInfo) => {
    await runAxeScan(page, testInfo, {
      label: "Dashboard (employee)",
      fileSlug: "employee-dashboard",
      tags: AXE_TAGS,
    });
  });

  test("my profile", async ({ page }, testInfo) => {
    await goToNavLink(page, "My Profile", /.+/);
    await runAxeScan(page, testInfo, {
      label: "My Profile (employee)",
      fileSlug: "employee-profile",
      tags: AXE_TAGS,
    });
  });

  test("apply for leave — default state", async ({ page }, testInfo) => {
    await goToNavLink(page, "Apply for Leave", "Apply for leave");
    await runAxeScan(page, testInfo, {
      label: "Apply for leave (default state)",
      fileSlug: "employee-leave-apply",
      tags: AXE_TAGS,
    });
  });

  test("apply for leave — half-day option expanded", async ({ page }, testInfo) => {
    await goToNavLink(page, "Apply for Leave", "Apply for leave");
    await page.getByLabel("This is a half-day request").check();
    await expect(page.getByLabel("Which half?")).toBeVisible();

    await runAxeScan(page, testInfo, {
      label: "Apply for leave (half-day expanded)",
      fileSlug: "employee-leave-apply-halfday",
      tags: AXE_TAGS,
    });
  });

  test("apply for leave — validation errors", async ({ page }, testInfo) => {
    await goToNavLink(page, "Apply for Leave", "Apply for leave");
    await page.getByRole("button", { name: "Submit request" }).click();
    await expect(page.getByRole("alert").first()).toBeVisible();

    await runAxeScan(page, testInfo, {
      label: "Apply for leave (validation errors)",
      fileSlug: "employee-leave-apply-errors",
      tags: AXE_TAGS,
    });
  });

  test("my leave history", async ({ page }, testInfo) => {
    await goToNavLink(page, "My Leave History", "My leave history");
    await runAxeScan(page, testInfo, {
      label: "My leave history (employee)",
      fileSlug: "employee-leave-history",
      tags: AXE_TAGS,
    });
  });

  test("holiday calendar", async ({ page }, testInfo) => {
    await goToNavLink(page, "Holiday Calendar", "Holiday calendar");
    await runAxeScan(page, testInfo, {
      label: "Holiday calendar (employee)",
      fileSlug: "employee-holiday-calendar",
      tags: AXE_TAGS,
    });
  });
});
