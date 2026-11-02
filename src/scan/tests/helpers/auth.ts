import path from "node:path";
import { Page, expect } from "@playwright/test";
import { Role, USERS } from "../fixtures/users.js";

export const AUTH_DIR = path.join(process.cwd(), "playwright/.auth");

export function authFile(role: Role) {
  return path.join(AUTH_DIR, `${role}.json`);
}

export async function login(page: Page, role: Role) {
  const { email, password } = USERS[role];
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Target backend is on Azure App Service; cold-start logins can exceed the default 5s.
  await expect(page.getByRole("heading", { level: 1, name: /Welcome back/ })).toBeVisible({ timeout: 45_000 });
}

export async function gotoAuthed(page: Page) {
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { level: 1, name: /Welcome back/ })).toBeVisible();
}

export async function goToNavLink(page: Page, linkName: string, headingName: string | RegExp) {
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: linkName }).click();
  await expect(page.getByRole("heading", { level: 1, name: headingName })).toBeVisible();
}
