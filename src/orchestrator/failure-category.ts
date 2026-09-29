import { ConfigError } from "../lib/preflight.js";
import { JiraAuthError } from "../integrations/tracker/errors.js";
import { GitHubAuthError } from "../integrations/vcs/errors.js";
import { GitNotCleanError, GitNotSyncedError } from "../lib/repo-config.js";
import { ReleaseError } from "../release/release-agent.js";

export interface CycleFailure {
  category: string;
  reason: string;
}

export function categorizeCycleFailure(err: unknown): CycleFailure {
  const reason = err instanceof Error ? err.message : String(err);
  if (err instanceof ConfigError) return { category: "config", reason };
  if (err instanceof JiraAuthError) return { category: "jira-auth", reason };
  if (err instanceof GitHubAuthError) return { category: "github-auth", reason };
  if (err instanceof GitNotCleanError || err instanceof GitNotSyncedError) {
    return { category: "git-precondition", reason };
  }
  if (err instanceof ReleaseError) return { category: "release", reason };
  return { category: "internal", reason };
}

/**
 * Formats the CYCLE_FAILED sentinel as a single line — ConfigError and
 * GitNotCleanError messages (and many exec errors) span multiple lines, and
 * the web dashboard's sentinel parser only reads whichever single log line
 * matches the pattern, so a multi-line reason would otherwise be truncated
 * to just its first line.
 */
export function formatCycleFailedSentinel(category: string, reason: string): string {
  const flatReason = reason.replace(/\s*\n\s*/g, " ").trim();
  return `CYCLE_FAILED: ${category} | ${flatReason}`;
}
