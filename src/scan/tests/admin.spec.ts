import { test } from "@playwright/test";
import { runAxeScan, AXE_TAGS } from "./helpers/axe.js";
import { authFile, gotoAuthed, goToNavLink } from "./helpers/auth.js";
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

  // Inactive tab panels are `hidden`, and axe skips hidden elements — the
  // test above only covers the default "Basic Info" tab, so scan the rest.
  const EMPLOYEE_FORM_TABS = [
    { name: "Contact", slug: "contact" },
    { name: "Job Details", slug: "job" },
    { name: "Statutory & Payroll", slug: "statutory" },
    { name: "Emergency Contact", slug: "emergency" },
    { name: "Leave Policy", slug: "leave" },
  ];

  for (const tab of EMPLOYEE_FORM_TABS) {
    test(`add employee form — ${tab.name} tab`, async ({ page }, testInfo) => {
      await goToNavLink(page, "Employees", "Employees");
      await page.getByRole("link", { name: "Add employee" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Add employee" })).toBeVisible();
      await page.getByRole("tab", { name: tab.name, exact: true }).click();
      await expect(page.getByRole("tab", { name: tab.name, exact: true })).toHaveAttribute("aria-selected", "true");

      await runAxeScan(page, testInfo, {
        label: `Add employee form — ${tab.name} tab (admin)`,
        fileSlug: `admin-employee-create-${tab.slug}`,
        tags: AXE_TAGS,
      });
    });
  }

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
