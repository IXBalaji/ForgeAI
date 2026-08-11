import "dotenv/config";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { traceable } from "langsmith/traceable";
import { db } from "../db/client.js";
import { tickets, issues, fixAttempts } from "../db/schema.js";
import { run } from "../lib/exec.js";
import { gitRepoMutex } from "../lib/mutex.js";
import { DEVELOPER_MODEL, DEVELOPER_EFFORT, LABEL_PREFIX_SLUG } from "../lib/config.js";

const TARGET_REPO_PATH = process.env.TARGET_REPO_PATH ?? "";
const QA_BRANCH = process.env.GITHUB_QA_BRANCH ?? "qa";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_OWNER = process.env.GITHUB_OWNER ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "";
const MAX_RETRIES = parseInt(process.env.CONFLICT_RESOLVER_MAX_RETRIES ?? "2", 10);

export interface ConflictResolveResult {
  resolved: boolean;
  commitSha: string | null;
  conflictFiles: string[];
}

/**
 * Resolves merge conflicts between a fix branch and the QA branch using the
 * Claude SDK agent. The agent sees the conflict markers, the Jira ticket
 * context, and the original fix intent, then edits the files to resolve
 * conflicts while preserving both the fix and upstream changes.
 *
 * Flow:
 *   1. Create a worktree from the fix branch
 *   2. Attempt `git merge origin/<qa>` locally — this produces conflict markers
 *   3. Feed the conflicted files + Jira context to the Claude SDK agent
 *   4. Agent resolves conflicts, stages, and commits
 *   5. Force-push the resolved branch back to remote
 *   6. Clean up worktree
 */
export const resolveConflicts = traceable(_resolveConflicts, {
  name: "conflict-resolver",
  run_type: "chain",
});

async function _resolveConflicts(fixAttemptId: string): Promise<ConflictResolveResult> {
  const [attempt] = await db
    .select()
    .from(fixAttempts)
    .where(eq(fixAttempts.id, fixAttemptId));
  if (!attempt) throw new Error(`FixAttempt ${fixAttemptId} not found`);

  const [ticket] = await db
    .select()
    .from(tickets)
    .where(eq(tickets.id, attempt.ticketId));

  const branch = attempt.branch;
  const baseName = branch.replace(/\//g, "-");
  const worktreeDir = join(
    TARGET_REPO_PATH,
    "..",
    ".worktrees",
    `${baseName}-conflict-resolve`,
  );

  console.log(`[conflict-resolver] Starting conflict resolution for branch ${branch}`);
  if (ticket?.jiraKey) {
    console.log(`[conflict-resolver] Jira reference: ${ticket.jiraKey}`);
  }

  let releaseLock = await gitRepoMutex.acquire();
  try {
    await run("git", ["fetch", "origin", QA_BRANCH, branch], TARGET_REPO_PATH);
    await run("git", ["worktree", "prune"], TARGET_REPO_PATH).catch(() => {});

    if (existsSync(worktreeDir)) {
      try {
        await run(
          "git",
          ["worktree", "remove", worktreeDir, "--force"],
          TARGET_REPO_PATH,
        );
      } catch {}
    }

    await run(
      "git",
      ["worktree", "add", worktreeDir, `origin/${branch}`],
      TARGET_REPO_PATH,
    );
  } finally {
    releaseLock();
  }

  // Attempt the merge locally — this will fail with conflict markers in files
  let conflictFiles: string[] = [];
  try {
    await run("git", ["merge", `origin/${QA_BRANCH}`, "--no-edit"], worktreeDir);
    // If merge succeeds without conflicts, we're done
    console.log(
      `[conflict-resolver] Merge succeeded without conflicts — no resolution needed.`,
    );
    const { stdout } = await run("git", ["rev-parse", "HEAD"], worktreeDir);
    const commitSha = stdout.trim();

    releaseLock = await gitRepoMutex.acquire();
    try {
      await forcePushBranch(branch, worktreeDir);
      await cleanupWorktree(worktreeDir);
    } finally {
      releaseLock();
    }

    return { resolved: true, commitSha, conflictFiles: [] };
  } catch (mergeErr) {
    const mergeMsg = (mergeErr as Error).message;
    if (!/conflict|merge/i.test(mergeMsg)) {
      console.error(
        `[conflict-resolver] Merge failed for non-conflict reason: ${mergeMsg}`,
      );
      releaseLock = await gitRepoMutex.acquire();
      try {
        await run("git", ["merge", "--abort"], worktreeDir).catch(() => {});
        await cleanupWorktree(worktreeDir);
      } finally {
        releaseLock();
      }
      return { resolved: false, commitSha: null, conflictFiles: [] };
    }
  }

  // Identify conflicted files
  try {
    const { stdout: statusOut } = await run(
      "git",
      ["diff", "--name-only", "--diff-filter=U"],
      worktreeDir,
    );
    conflictFiles = statusOut.trim().split("\n").filter(Boolean);
    console.log(
      `[conflict-resolver] ${conflictFiles.length} conflicted file(s): ${conflictFiles.join(", ")}`,
    );
  } catch {
    console.error(`[conflict-resolver] Could not identify conflicted files.`);
    releaseLock = await gitRepoMutex.acquire();
    try {
      await run("git", ["merge", "--abort"], worktreeDir).catch(() => {});
      await cleanupWorktree(worktreeDir);
    } finally {
      releaseLock();
    }
    return { resolved: false, commitSha: null, conflictFiles: [] };
  }

  if (conflictFiles.length === 0) {
    console.warn(`[conflict-resolver] No conflicted files detected — aborting.`);
    releaseLock = await gitRepoMutex.acquire();
    try {
      await run("git", ["merge", "--abort"], worktreeDir).catch(() => {});
      await cleanupWorktree(worktreeDir);
    } finally {
      releaseLock();
    }
    return { resolved: false, commitSha: null, conflictFiles: [] };
  }

  // Build context for the agent
  const prompt = await buildConflictPrompt(
    attempt,
    ticket,
    conflictFiles,
    worktreeDir,
  );

  console.log(
    `[conflict-resolver] Running Claude SDK agent to resolve ${conflictFiles.length} conflict(s)...`,
  );
  const sdkStart = Date.now();
  await runConflictAgent(prompt, worktreeDir);
  const sdkDuration = ((Date.now() - sdkStart) / 1000).toFixed(1);
  console.log(
    `[conflict-resolver] SDK agent finished (${sdkDuration}s)`,
  );

  // Check if conflicts are actually resolved
  try {
    const { stdout: remaining } = await run(
      "git",
      ["diff", "--name-only", "--diff-filter=U"],
      worktreeDir,
    );
    const stillConflicted = remaining.trim().split("\n").filter(Boolean);
    if (stillConflicted.length > 0) {
      console.error(
        `[conflict-resolver] ${stillConflicted.length} file(s) still have conflicts: ${stillConflicted.join(", ")}`,
      );
      releaseLock = await gitRepoMutex.acquire();
      try {
        await run("git", ["merge", "--abort"], worktreeDir).catch(() => {});
        await cleanupWorktree(worktreeDir);
      } finally {
        releaseLock();
      }
      return { resolved: false, commitSha: null, conflictFiles };
    }
  } catch {}

  // Stage and commit the resolution
  let commitSha: string | null = null;
  releaseLock = await gitRepoMutex.acquire();
  try {
    await run("git", ["add", "-A"], worktreeDir);

    const { stdout: statusOut } = await run(
      "git",
      ["status", "--porcelain"],
      worktreeDir,
    );
    if (statusOut.trim().length === 0) {
      console.warn(
        `[conflict-resolver] No changes after resolution — merge may have been trivial.`,
      );
    }

    const jiraRef = ticket?.jiraKey ? ` [${ticket.jiraKey}]` : "";
    await run(
      "git",
      [
        "commit",
        "--no-edit",
        "-m",
        `fix(${LABEL_PREFIX_SLUG}):${jiraRef} resolve merge conflicts for ${branch}`,
      ],
      worktreeDir,
    );

    const { stdout } = await run("git", ["rev-parse", "HEAD"], worktreeDir);
    commitSha = stdout.trim();
    console.log(
      `[conflict-resolver] Committed resolution ${commitSha} on branch ${branch}`,
    );

    await forcePushBranch(branch, worktreeDir);
    await cleanupWorktree(worktreeDir);
  } finally {
    releaseLock();
  }

  console.log(
    `[conflict-resolver] Conflicts resolved and pushed for ${branch}${ticket?.jiraKey ? ` (${ticket.jiraKey})` : ""}`,
  );

  return { resolved: true, commitSha, conflictFiles };
}

async function forcePushBranch(
  branch: string,
  worktreeDir: string,
): Promise<void> {
  if (GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO) {
    const authRemote = `https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git`;
    await run("git", ["remote", "set-url", "origin", authRemote], worktreeDir);
  }
  await run(
    "git",
    ["-c", "credential.helper=", "push", "--force-with-lease", "-u", "origin", branch],
    worktreeDir,
  );
  console.log(`[conflict-resolver] Force-pushed resolved branch ${branch}`);
}

async function cleanupWorktree(worktreeDir: string): Promise<void> {
  try {
    await run(
      "git",
      ["worktree", "remove", "--force", worktreeDir],
      TARGET_REPO_PATH,
    );
  } catch {
    console.warn(
      `[conflict-resolver] Could not remove worktree at ${worktreeDir} — clean up manually.`,
    );
  }
}

async function buildConflictPrompt(
  attempt: any,
  ticket: any,
  conflictFiles: string[],
  worktreeDir: string,
): Promise<string> {
  // Gather the diff context for conflicted files
  let conflictContent = "";
  for (const file of conflictFiles) {
    try {
      const { stdout } = await run("git", ["diff", "--", file], worktreeDir);
      conflictContent += `\n--- ${file} ---\n${stdout.slice(0, 3000)}\n`;
    } catch {}
  }

  // Get the original fix commit message for intent context
  let fixCommitMsg = "";
  try {
    const { stdout } = await run(
      "git",
      ["log", "--format=%B", "-1", `origin/${attempt.branch}`],
      worktreeDir,
    );
    fixCommitMsg = stdout.trim();
  } catch {}

  // Get Jira ticket context
  let ticketContext = "";
  if (ticket) {
    ticketContext = `Jira ticket: ${ticket.jiraKey ?? "none"}\nCategory: ${ticket.category}\n`;
    const issueIds = (ticket.issueIds as string[]) ?? [];
    if (issueIds.length > 0) {
      const ticketIssues = await db
        .select()
        .from(issues)
        .where(inArray(issues.id, issueIds));
      if (ticketIssues.length > 0) {
        ticketContext += "Original accessibility findings:\n";
        for (const i of ticketIssues) {
          const route = i.pageUrl.replace(/^https?:\/\/[^/]+/, "") || "/";
          ticketContext += `  - ${i.wcagRule} at "${i.selector}" on ${route} (${i.severity})\n`;
        }
      }
    }
  }

  return [
    `You are resolving merge conflicts between a fix branch and the ${QA_BRANCH} integration branch.`,
    ``,
    `CRITICAL RULES:`,
    `- You are working inside a git worktree. ALL file reads and edits MUST stay within your current working directory.`,
    `- The merge has already been started — files contain conflict markers (<<<<<<< HEAD, =======, >>>>>>>).`,
    `- Your job is to resolve ALL conflict markers while preserving BOTH:`,
    `  1. The accessibility fix from the feature branch (this is the primary intent)`,
    `  2. Any legitimate upstream changes from ${QA_BRANCH} that don't contradict the fix`,
    `- When in doubt, favor the accessibility fix — that is the purpose of this branch.`,
    `- After resolving, there should be ZERO conflict markers (<<<<<<< or ======= or >>>>>>>) in any file.`,
    `- Do NOT create new files or make changes beyond resolving the conflicts.`,
    ``,
    `CONTEXT:`,
    `Branch: ${attempt.branch}`,
    `Fix commit: ${fixCommitMsg}`,
    ticketContext,
    ``,
    `CONFLICTED FILES (${conflictFiles.length}):`,
    conflictFiles.map((f) => `  - ${f}`).join("\n"),
    ``,
    `CONFLICT DIFFS:`,
    conflictContent,
    ``,
    `STEPS:`,
    `1. Read each conflicted file to see the full conflict markers in context.`,
    `2. For each file, edit to resolve the conflicts — remove all <<<<<<< ======= >>>>>>> markers.`,
    `3. Use Grep to verify NO conflict markers remain: grep for "<<<<<<< " across all files.`,
    `4. Do NOT run git add or git commit — the caller handles that.`,
  ]
    .filter(Boolean)
    .join("\n");
}

const runConflictAgent = traceable(_runConflictAgent, {
  name: "conflict-resolver-sdk-call",
  run_type: "llm",
});

async function _runConflictAgent(
  prompt: string,
  worktreeDir: string,
): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "[conflict-resolver] ANTHROPIC_API_KEY not set — cannot resolve conflicts automatically.",
    );
    return;
  }

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        console.log(
          `[conflict-resolver] Retrying SDK call (attempt ${attempt + 1}/${MAX_RETRIES + 1})...`,
        );
      }
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      for await (const message of query({
        prompt,
        options: {
          cwd: worktreeDir,
          allowedTools: ["Read", "Edit", "Grep", "Glob"],
          permissionMode: "acceptEdits",
          model: DEVELOPER_MODEL,
          effort: DEVELOPER_EFFORT,
        },
      } as any)) {
        if ((message as any).type === "assistant") {
          console.log(
            "[conflict-resolver]",
            JSON.stringify((message as any).message?.content ?? message),
          );
        }
      }
      return;
    } catch (err) {
      lastErr = err as Error;
      const isRetryable =
        /timeout|ECONNRESET|529|overloaded|rate.limit|socket hang up/i.test(
          lastErr.message,
        );
      if (!isRetryable || attempt >= MAX_RETRIES) break;
      const delay = Math.min(1000 * 2 ** attempt, 30000);
      console.warn(
        `[conflict-resolver] SDK call failed (${lastErr.message}), retrying in ${delay / 1000}s...`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  console.warn(
    `[conflict-resolver] SDK call failed after ${MAX_RETRIES + 1} attempts: ${lastErr?.message}`,
  );
}
