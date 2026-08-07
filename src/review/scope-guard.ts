import { run } from "../lib/exec.js";

const BASE_BRANCH = process.env.GITHUB_BASE_BRANCH ?? "master";
const SCOPE_GUARD_MAX_LINES = 200;
const SENSITIVE_PATH_PATTERNS = [/auth/i, /payment/i, /security/i, /\.env/i, /jwt/i];

export interface ScopeGuardResult {
  flagged: boolean;
  reason: string;
}

/**
 * Flags a fix for manual review — held out of the automatic merge, per
 * architecture doc §06 — if its diff touches a sensitive path or exceeds a
 * line-count threshold, regardless of what the rest of the review concludes.
 */
export async function scopeGuard(worktreeDir: string): Promise<ScopeGuardResult> {
  const { stdout } = await run("git", ["diff", "--stat", BASE_BRANCH], worktreeDir);
  const lines = stdout.trim().split("\n");
  const summary = lines[lines.length - 1] ?? "";
  const changedMatch = summary.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
  const totalChangedLines = changedMatch ? Number(changedMatch[2] ?? 0) + Number(changedMatch[3] ?? 0) : 0;

  const { stdout: nameOnly } = await run("git", ["diff", "--name-only", BASE_BRANCH], worktreeDir);
  const touchedFiles = nameOnly.trim().split("\n").filter(Boolean);
  const touchesSensitivePath = touchedFiles.some((f) => SENSITIVE_PATH_PATTERNS.some((p) => p.test(f)));

  if (touchesSensitivePath) {
    return { flagged: true, reason: `Diff touches a sensitive path: ${touchedFiles.join(", ")}` };
  }
  if (totalChangedLines > SCOPE_GUARD_MAX_LINES) {
    return { flagged: true, reason: `Diff changes ${totalChangedLines} lines, exceeding the ${SCOPE_GUARD_MAX_LINES}-line threshold.` };
  }
  return { flagged: false, reason: "" };
}
