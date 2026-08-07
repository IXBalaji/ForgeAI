import { test as setup } from "@playwright/test";
import { login, authFile } from "./helpers/auth";
import type { Role } from "./fixtures/users";

const ROLES: Role[] = ["admin", "manager", "employee"];

for (const role of ROLES) {
  setup(`authenticate as ${role}`, async ({ page }) => {
    await login(page, role);
    await page.context().storageState({ path: authFile(role) });
  });
}
