import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { run } from "./exec.js";

export function assertTargetRepoConfigured(): string {
  const repoPath = process.env.TARGET_REPO_PATH?.trim();
  if (!repoPath) {
    throw new Error("TARGET_REPO_PATH is not configured. Add it to .env and point it at the repository root.");
  }

  if (!existsSync(repoPath)) {
    throw new Error(`TARGET_REPO_PATH is configured to "${repoPath}", but that directory does not exist. Create the repo path or fix the config.`);
  }

  if (!existsSync(resolve(repoPath, ".git"))) {
    throw new Error(`TARGET_REPO_PATH is set to "${repoPath}", but it is not a Git repository. Check the repo path and remote setup.`);
  }

  return repoPath;
}

export async function ensureFreshQaBase(repoPath = assertTargetRepoConfigured()): Promise<void> {
  const qaBranch = process.env.GITHUB_QA_BRANCH ?? "qa";
  await run("git", ["fetch", "--all", "--prune"], repoPath);
  await run("git", ["fetch", "origin", qaBranch], repoPath);
}
