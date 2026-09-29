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

export class GitNotCleanError extends Error {
  constructor(dirtyFiles: string[]) {
    super(`Working tree is not clean — commit, stash, or discard changes before running:\n${dirtyFiles.map((f) => `  ${f}`).join("\n")}`);
    this.name = "GitNotCleanError";
  }
}

export class GitNotSyncedError extends Error {
  constructor(branch: string, direction: "behind" | "ahead") {
    super(
      direction === "behind"
        ? `Branch "${branch}" is behind origin/${branch} — pull the latest changes before running.`
        : `Branch "${branch}" has unpushed commits ahead of origin/${branch} — push before running.`,
    );
    this.name = "GitNotSyncedError";
  }
}

/**
 * Confirms the target repo is safe to start a new cycle on: no uncommitted
 * changes, and the base branch is neither behind nor ahead of origin.
 */
export async function assertRepoReadyForCycle(repoPath = assertTargetRepoConfigured()): Promise<void> {
  const { stdout: statusOut } = await run("git", ["status", "--porcelain"], repoPath);
  const dirtyFiles = statusOut.split("\n").map((l) => l.trim()).filter(Boolean);
  if (dirtyFiles.length > 0) {
    throw new GitNotCleanError(dirtyFiles);
  }

  const branch = process.env.GITHUB_QA_BRANCH ?? "qa";

  // This pipeline creates worktrees straight from origin/<branch> and never
  // checks the branch out in TARGET_REPO_PATH itself, so there is usually no
  // local ref to compare — that's the common case, not something to report.
  // Only run the ahead/behind check when a local ref genuinely exists (e.g. a
  // human checked it out manually).
  const hasLocalBranch = await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoPath)
    .then(() => true)
    .catch(() => false);
  if (!hasLocalBranch) return;

  await run("git", ["fetch", "origin", branch], repoPath);
  const { stdout: countsOut } = await run(
    "git",
    ["rev-list", "--left-right", "--count", `${branch}...origin/${branch}`],
    repoPath,
  );
  const [aheadStr, behindStr] = countsOut.trim().split(/\s+/);
  const ahead = parseInt(aheadStr ?? "0", 10);
  const behind = parseInt(behindStr ?? "0", 10);
  if (behind > 0) throw new GitNotSyncedError(branch, "behind");
  if (ahead > 0) throw new GitNotSyncedError(branch, "ahead");
}
