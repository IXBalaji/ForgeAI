import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { run } from "./exec.js";
import { logger } from "./logger.js";

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
 * changes, and the base branch is not ahead of origin. If the local branch is
 * merely behind (the common case when a previous cycle or a teammate merged
 * remotely since this checkout last fetched), it is fast-forwarded
 * automatically instead of failing the cycle — that's a safe, lossless
 * update, unlike "ahead" which means there are local commits that could be
 * lost by rewriting the ref.
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

  // Diverged or ahead both mean local commits exist that aren't on origin —
  // fast-forwarding would discard them, so this still requires a human.
  if (ahead > 0) throw new GitNotSyncedError(branch, "ahead");

  if (behind > 0) {
    logger.warn("preflight", `Local "${branch}" is ${behind} commit(s) behind origin/${branch} — fast-forwarding before starting the cycle.`);
    const { stdout: currentBranchOut } = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
    if (currentBranchOut.trim() === branch) {
      await run("git", ["merge", "--ff-only", `origin/${branch}`], repoPath);
    } else {
      // Branch isn't checked out — safe to move the ref directly without
      // touching the working tree.
      await run("git", ["fetch", "origin", `${branch}:${branch}`], repoPath);
    }
    logger.info("preflight", `"${branch}" is now up to date with origin/${branch}.`);
  }
}
