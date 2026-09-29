import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "./logger.js";

export interface ConfigRequirements {
  db?: boolean;
  repo?: boolean;
  jira?: boolean;
  github?: boolean;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Configuration is incomplete:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/**
 * Collects every configuration problem for the given requirements in one
 * pass — rather than throwing on the first missing variable — so whoever
 * is running this sees the complete list of what to fix at once.
 */
export function validateConfig(requirements: ConfigRequirements = {}): void {
  const problems: string[] = [];

  if (!process.env.PROJECT_KEY?.trim()) {
    problems.push('PROJECT_KEY is not set — e.g. PROJECT_KEY="ELMS". Set it in .env.');
  }

  if (requirements.db && !process.env.DATABASE_URL?.trim()) {
    problems.push("DATABASE_URL is not set — set it in .env to a valid Postgres connection string.");
  }

  if (requirements.repo) {
    const repoPath = process.env.TARGET_REPO_PATH?.trim();
    if (!repoPath) {
      problems.push("TARGET_REPO_PATH is not set. Add it to .env and point it at the repository root.");
    } else if (!existsSync(repoPath)) {
      problems.push(`TARGET_REPO_PATH is set to "${repoPath}", but that directory does not exist.`);
    } else if (!existsSync(resolve(repoPath, ".git"))) {
      problems.push(`TARGET_REPO_PATH is set to "${repoPath}", but it is not a Git repository.`);
    }
  }

  if (requirements.jira) {
    if (!process.env.JIRA_BASE_URL?.trim()) problems.push("JIRA_BASE_URL is not set.");
    if (!process.env.JIRA_EMAIL?.trim()) problems.push("JIRA_EMAIL is not set.");
    if (!process.env.JIRA_API_TOKEN?.trim()) problems.push("JIRA_API_TOKEN is not set.");
  }

  if (requirements.github) {
    if (!process.env.GITHUB_TOKEN?.trim()) problems.push("GITHUB_TOKEN is not set.");
    if (!process.env.GITHUB_OWNER?.trim()) problems.push("GITHUB_OWNER is not set.");
    if (!process.env.GITHUB_REPO?.trim()) problems.push("GITHUB_REPO is not set.");
  }

  if (problems.length > 0) {
    const error = new ConfigError(problems);
    logger.error("preflight", "Configuration validation failed", error);
    throw error;
  }
}
