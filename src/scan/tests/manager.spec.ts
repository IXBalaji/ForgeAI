import { test } from "@playwright/test";
import { runAxeScan, AXE_TAGS } from "./helpers/axe.js";
import { authFile, gotoAuthed, goToNavLink } from "./helpers/auth.js";

test.describe("Manager role", () => {
  test.use({ storageState: authFile("manager") });

  test.beforeEach(async ({ page }) => {
    await gotoAuthed(page);
  });

  test("dashboard — includes pending approvals card", async ({ page }, testInfo) => {
    await runAxeScan(page, testInfo, {
      label: "Dashboard (manager)",
      fileSlug: "manager-dashboard",
      tags: AXE_TAGS,
    });
  });

  test("my team", async ({ page }, testInfo) => {
    await goToNavLink(page, "My Team", "My team");
    await runAxeScan(page, testInfo, {
      label: "My team (manager)",
      fileSlug: "manager-team",
      tags: AXE_TAGS,
    });
  });

  test("approvals", async ({ page }, testInfo) => {
    await goToNavLink(page, "Approvals", "Approvals");
    await runAxeScan(page, testInfo, {
      label: "Approvals (manager)",
      fileSlug: "manager-approvals",
      tags: AXE_TAGS,
    });
  });
});
