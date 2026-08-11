import "dotenv/config";
import { join, resolve } from "node:path";
import { rm } from "node:fs/promises";
import { eq, inArray } from "drizzle-orm";
import { traceable } from "langsmith/traceable";
import { db } from "../db/client.js";
import { tickets, fixAttempts, issues } from "../db/schema.js";
import { run } from "../lib/exec.js";
import { transitionTicket } from "../integrations/jira.js";
import { LABEL_PREFIX_SLUG, DEVELOPER_MODEL, DEVELOPER_EFFORT } from "../lib/config.js";
import { buildPrompt } from "./prompt-builder.js";
import { gitRepoMutex } from "../lib/mutex.js";

const TARGET_REPO_PATH = process.env.TARGET_REPO_PATH ?? "";
const BASE_BRANCH = process.env.GITHUB_BASE_BRANCH ?? "qa";
const QA_BRANCH = process.env.GITHUB_QA_BRANCH ?? "qa";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_OWNER = process.env.GITHUB_OWNER ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "";
const MAX_RETRIES = parseInt(process.env.DEVELOPER_MAX_RETRIES ?? "2", 10);

export interface DeveloperResult {
  fixAttemptId: string | null;
  branch: string;
  prUrl: string | null;
}

async function ensureWorktree(branch: string, worktreeDir: string): Promise<void> {
  // Always base the worktree on origin/<qa> so we start from the latest remote
  // state — using a local branch ref can be stale if a previous deploy merged
  // into qa remotely but we never pulled.
  const startPoint = `origin/${QA_BRANCH}`;
  try {
    await run("git", ["worktree", "add", "-b", branch, worktreeDir, startPoint], TARGET_REPO_PATH);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("already exists")) {
      console.warn(`[developer] Branch/worktree "${branch}" already exists — cleaning up and retrying.`);
      try { await run("git", ["worktree", "remove", worktreeDir, "--force"], TARGET_REPO_PATH); } catch { /* may not exist on disk */ }
      try { await run("git", ["branch", "-D", branch], TARGET_REPO_PATH); } catch { /* may not exist */ }
      await run("git", ["worktree", "add", "-b", branch, worktreeDir, startPoint], TARGET_REPO_PATH);
    } else {
      throw err;
    }
  }
}

// traceable so the actual model interaction shows up in LangSmith with its
// full prompt/response — the Claude Agent SDK isn't LangChain-native, so
// LangSmith's automatic LangGraph tracing has no visibility into this call
// on its own.
const runAgentWithRetry = traceable(_runAgentWithRetry, { name: "developer-agent-sdk-call", run_type: "llm" });

async function _runAgentWithRetry(prompt: string, worktreeDir: string): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("[developer] ANTHROPIC_API_KEY not set — skipping the actual fix, worktree left in place.");
    return;
  }

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`[developer] Retrying Claude Agent SDK call (attempt ${attempt + 1}/${MAX_RETRIES + 1})...`);
      }
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      for await (const message of query({
        prompt,
        options: {
          cwd: worktreeDir,
          allowedTools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
          permissionMode: "acceptEdits",
          model: DEVELOPER_MODEL,
          effort: DEVELOPER_EFFORT,
        },
      } as any)) {
        if ((message as any).type === "assistant") {
          console.log("[developer]", JSON.stringify((message as any).message?.content ?? message));
        }
      }
      return;
    } catch (err) {
      lastErr = err as Error;
      const isRetryable = /timeout|ECONNRESET|529|overloaded|rate.limit|socket hang up/i.test(lastErr.message);
      if (!isRetryable || attempt >= MAX_RETRIES) break;
      const delay = Math.min(1000 * 2 ** attempt, 30000);
      console.warn(`[developer] Agent call failed (${lastErr.message}), retrying in ${delay / 1000}s...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  console.warn(`[developer] Agent call failed after ${MAX_RETRIES + 1} attempts: ${lastErr?.message}`);
}

export const runDeveloperAgent = traceable(_runDeveloperAgent, { name: "developer-agent", run_type: "chain" });

async function _runDeveloperAgent(ticketId: string): Promise<DeveloperResult> {
  if (!TARGET_REPO_PATH) throw new Error("TARGET_REPO_PATH is not set.");

  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
  if (ticket?.jiraKey) {
    await transitionTicket(ticket.jiraKey, "In Progress");
  }

  const existingAttempts = await db
    .select()
    .from(fixAttempts)
    .where(eq(fixAttempts.ticketId, ticketId));
  const attemptNumber = existingAttempts.length + 1;

  const shortId = ticketId.slice(0, 8);
  const jiraSlug = ticket?.jiraKey ? `${ticket.jiraKey}-` : "";
  const branch = `${LABEL_PREFIX_SLUG}/${jiraSlug}${shortId}-attempt-${attemptNumber}`;
  const worktreeDir = join(TARGET_REPO_PATH, "..", `.worktrees`, branch.replace(/\//g, "-"));

  // Serialize git worktree creation — git holds a repo-level lock
  let releaseLock = await gitRepoMutex.acquire();
  try {
    await run("git", ["fetch", "origin", QA_BRANCH], TARGET_REPO_PATH);
    await ensureWorktree(branch, worktreeDir);
  } finally {
    releaseLock();
  }

  // Early exit if the ticket has no resolvable issues — avoids wasting 5+ min on an empty SDK call
  const rawIssueIds = (ticket?.issueIds as string[]) ?? [];
  const ticketIssues = rawIssueIds.length > 0
    ? await db.select().from(issues).where(inArray(issues.id, rawIssueIds))
    : [];
  if (ticketIssues.length === 0) {
    console.warn(`[developer] Ticket ${ticketId} has no resolvable issues — skipping SDK agent.`);
    console.warn(`[developer]   ticket.issueIds (${rawIssueIds.length}): ${JSON.stringify(rawIssueIds)}`);
    console.warn(`[developer]   issues found in DB: ${ticketIssues.length}`);
    if (rawIssueIds.length > 0) {
      console.warn(`[developer]   ⚠ The issueIds exist on the ticket but no matching rows were found in the issues table.`);
      console.warn(`[developer]   This usually means: (a) issues were created in a different scan run that was deleted,`);
      console.warn(`[developer]   (b) the triage step stored stale/incorrect issueIds, or (c) the issues table was truncated.`);
    } else {
      console.warn(`[developer]   ⚠ The ticket has an empty issueIds array — triage may not have linked any issues to it.`);
    }
    if (ticket?.jiraKey) await transitionTicket(ticket.jiraKey, "To Do");
    await db.update(tickets).set({ status: "open" }).where(eq(tickets.id, ticketId));
    const cleanupLock = await gitRepoMutex.acquire();
    try {
      await run("git", ["worktree", "remove", "--force", worktreeDir], TARGET_REPO_PATH);
    } catch { /* best effort */ } finally { cleanupLock(); }
    return { fixAttemptId: null, branch, prUrl: null };
  }

  // Claude SDK fix runs unlocked — multiple tickets fix in parallel
  const prompt = await buildPrompt(ticketId);
  console.log(`[developer] ── SDK agent starting for ticket ${ticketId} on branch ${branch} ──`);
  console.log(`[developer]   Worktree: ${worktreeDir}`);
  console.log(`[developer]   Prompt length: ${prompt.length} chars`);
  const sdkStart = Date.now();
  await runAgentWithRetry(prompt, worktreeDir);
  const sdkDuration = ((Date.now() - sdkStart) / 1000).toFixed(1);
  console.log(`[developer] ── SDK agent finished for ticket ${ticketId} (${sdkDuration}s) ──`);

  // Log raw working tree state before acquiring lock — shows what the SDK
  // agent actually touched, independent of git add / commit.
  try {
    const { stdout: rawStatus } = await run("git", ["status", "--short"], worktreeDir);
    if (rawStatus.trim()) {
      console.log(`[developer] Working tree changes after SDK (ticket ${ticketId}):`);
      for (const line of rawStatus.trim().split("\n")) {
        console.log(`[developer]   ${line}`);
      }
    } else {
      console.warn(`[developer] Working tree is clean after SDK — no files were modified (ticket ${ticketId}).`);
    }
  } catch {
    console.warn(`[developer] Could not read working tree status for ticket ${ticketId}.`);
  }

  // Re-acquire lock for commit, push, and worktree cleanup
  let commitSha: string | null = null;
  let pushStatus: "pending" | "pushed" | "failed" = "pending";
  const prUrl: string | null = null;
  let fixAttemptId: string | null = null;

  releaseLock = await gitRepoMutex.acquire();
  try {
    // Remove Windows reserved device names (nul, con, prn, aux, etc.) that the
    // Claude SDK agent may have created — they break `git add` on Windows.
    try {
      const { stdout: lsOut } = await run(
        "git", ["ls-files", "--others", "--exclude-standard"], worktreeDir,
      );
      const reserved = /^(nul|con|prn|aux|com[0-9]|lpt[0-9])(\..+)?$/i;
      for (const f of lsOut.split("\n").map((l) => l.trim()).filter(Boolean)) {
        if (reserved.test(f.split("/").pop()!)) {
          console.warn(`[developer] Removing Windows-reserved file: ${f}`);
          await run("git", ["rm", "-f", "--", f], worktreeDir).catch(() =>
            rm(resolve(worktreeDir, f), { force: true }).catch(() => {}),
          );
        }
      }
    } catch {
      // best-effort cleanup
    }

    await run("git", ["add", "-A"], worktreeDir);

    const { stdout: statusOut } = await run("git", ["status", "--porcelain"], worktreeDir);
    if (statusOut.trim().length === 0) {
      console.warn(`[developer] No file changes detected for ticket ${ticketId} — the SDK agent did not modify any files.`);
    } else {
      const changedFiles = statusOut.trim().split("\n");
      console.log(`[developer] ── Changes by SDK agent on branch ${branch} (${changedFiles.length} file(s)) ──`);
      for (const line of changedFiles) {
        console.log(`[developer]   ${line}`);
      }

      const { stdout: diffStat } = await run("git", ["diff", "--cached", "--stat"], worktreeDir);
      if (diffStat.trim()) {
        console.log(`[developer] ── Diff summary ──`);
        for (const line of diffStat.trim().split("\n")) {
          console.log(`[developer]   ${line}`);
        }
      }

      const jiraRef = ticket?.jiraKey ? ` [${ticket.jiraKey}]` : "";
      await run("git", ["commit", "-m", `fix(${LABEL_PREFIX_SLUG}):${jiraRef} ${branch}`], worktreeDir);
      const { stdout } = await run("git", ["rev-parse", "HEAD"], worktreeDir);
      commitSha = stdout.trim();
      console.log(`[developer] Committed ${commitSha} on branch ${branch}`);
    }

    if (commitSha) {
      if (GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO) {
        const authRemote = `https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git`;
        await run("git", ["remote", "set-url", "origin", authRemote], worktreeDir);
      }

      const PUSH_MAX_RETRIES = 3;
      for (let pushAttempt = 0; pushAttempt < PUSH_MAX_RETRIES; pushAttempt++) {
        try {
          await run("git", ["-c", "credential.helper=", "push", "-u", "origin", branch], worktreeDir);
          pushStatus = "pushed";
          break;
        } catch (err) {
          const isLast = pushAttempt >= PUSH_MAX_RETRIES - 1;
          if (isLast) {
            pushStatus = "failed";
            console.error(`[developer] Push failed after ${PUSH_MAX_RETRIES} attempts for branch ${branch}.`, err);
            if (ticket?.jiraKey) await transitionTicket(ticket.jiraKey, "To Do");
            await db.update(tickets).set({ status: "open" }).where(eq(tickets.id, ticketId));
            throw err;
          }
          const delay = Math.min(1000 * 2 ** pushAttempt, 10000);
          console.warn(`[developer] Push attempt ${pushAttempt + 1} failed, retrying in ${delay / 1000}s...`, (err as Error).message);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    // Only create a fix attempt record and advance the ticket if we actually
    // committed and pushed. Otherwise leave the ticket as "open" so the graph
    // recovery logic retries it on the next cycle.
    if (!commitSha) {
      console.warn(`[developer] No commit produced for ticket ${ticketId} on branch ${branch} — resetting ticket.`);
      if (ticket?.jiraKey) await transitionTicket(ticket.jiraKey, "To Do");
      await db.update(tickets).set({ status: "open" }).where(eq(tickets.id, ticketId));
    } else {
      const [attempt] = await db
        .insert(fixAttempts)
        .values({
          ticketId,
          branch,
          commitSha,
          pushStatus,
          prUrl,
          developerAgentRunId: `dev-${Date.now()}`,
          attemptNumber,
        })
        .returning();

      fixAttemptId = attempt.id;

      await db.update(tickets).set({ status: "in_review" }).where(eq(tickets.id, ticketId));
    }

    try {
      await run("git", ["worktree", "remove", "--force", worktreeDir], TARGET_REPO_PATH);
    } catch {
      console.warn(`[developer] Could not remove worktree at ${worktreeDir} — clean up manually.`);
    }
  } finally {
    releaseLock();
  }

  return { fixAttemptId, branch, prUrl };
}
