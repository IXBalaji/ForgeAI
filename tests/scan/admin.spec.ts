import { test } from "@playwright/test";
import { runAxeScan, AXE_TAGS } from "./helpers/axe";
import { authFile, gotoAuthed, goToNavLink } from "./helpers/auth";
import { expect } from "@playwright/test";

test.describe("Admin role", () => {
  test.use({ storageState: authFile("admin") });

  test.beforeEach(async ({ page }) => {
    await gotoAuthed(page);
  });

  test("dashboard — includes total employees card", async ({ page }, testInfo) => {
    await runAxeScan(page, testInfo, {
      label: "Dashboard (admin)",
      fileSlug: "admin-dashboard",
      tags: AXE_TAGS,
    });
  });

  test("employees list", async ({ page }, testInfo) => {
    await goToNavLink(page, "Employees", "Employees");
    await runAxeScan(page, testInfo, {
      label: "Employees list (admin)",
      fileSlug: "admin-employees-list",
      tags: AXE_TAGS,
    });
  });

  test("add employee form", async ({ page }, testInfo) => {
    await goToNavLink(page, "Employees", "Employees");
    await page.getByRole("link", { name: "Add employee" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Add employee" })).toBeVisible();

    await runAxeScan(page, testInfo, {
      label: "Add employee form (admin)",
      fileSlug: "admin-employee-create",
      tags: AXE_TAGS,
    });
  });

  test("departments", async ({ page }, testInfo) => {
    await goToNavLink(page, "Departments", "Departments");
    await runAxeScan(page, testInfo, {
      label: "Departments (admin)",
      fileSlug: "admin-departments",
      tags: AXE_TAGS,
    });
  });

  test("leave policies", async ({ page }, testInfo) => {
    await goToNavLink(page, "Leave Policies", "Leave policies");
    await runAxeScan(page, testInfo, {
      label: "Leave policies (admin)",
      fileSlug: "admin-leave-policies",
      tags: AXE_TAGS,
    });
  });

  test("holidays", async ({ page }, testInfo) => {
    await goToNavLink(page, "Holidays", "Holidays");
    await runAxeScan(page, testInfo, {
      label: "Holidays (admin)",
      fileSlug: "admin-holidays",
      tags: AXE_TAGS,
    });
  });
});
