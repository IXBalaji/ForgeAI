import "dotenv/config";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { traceable } from "langsmith/traceable";
import { db } from "../db/client.js";
import { tickets, fixAttempts } from "../db/schema.js";
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
  fixAttemptId: string;
  branch: string;
  prUrl: string | null;
}

async function ensureWorktree(branch: string, worktreeDir: string): Promise<void> {
  try {
    await run("git", ["worktree", "add", "-b", branch, worktreeDir, BASE_BRANCH], TARGET_REPO_PATH);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("already exists")) {
      console.warn(`[developer] Branch/worktree "${branch}" already exists — cleaning up and retrying.`);
      try { await run("git", ["worktree", "remove", worktreeDir, "--force"], TARGET_REPO_PATH); } catch { /* may not exist on disk */ }
      try { await run("git", ["branch", "-D", branch], TARGET_REPO_PATH); } catch { /* may not exist */ }
      await run("git", ["worktree", "add", "-b", branch, worktreeDir, BASE_BRANCH], TARGET_REPO_PATH);
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
  const branch = `${LABEL_PREFIX_SLUG}/${shortId}-attempt-${attemptNumber}`;
  const worktreeDir = join(TARGET_REPO_PATH, "..", `.worktrees`, branch.replace(/\//g, "-"));

  // Serialize git worktree creation — git holds a repo-level lock
  let releaseLock = await gitRepoMutex.acquire();
  try {
    await run("git", ["fetch", "origin", QA_BRANCH], TARGET_REPO_PATH);
    await ensureWorktree(branch, worktreeDir);
  } finally {
    releaseLock();
  }

  // Claude SDK fix runs unlocked — multiple tickets fix in parallel
  const prompt = await buildPrompt(ticketId);
  await runAgentWithRetry(prompt, worktreeDir);

  // Re-acquire lock for commit, push, and worktree cleanup
  let commitSha: string | null = null;
  const prUrl: string | null = null;
  releaseLock = await gitRepoMutex.acquire();
  try {
    try {
      await run("git", ["add", "-A"], worktreeDir);
      await run("git", ["commit", "-m", `fix(${LABEL_PREFIX_SLUG}): ${branch}`], worktreeDir);
      const { stdout } = await run("git", ["rev-parse", "HEAD"], worktreeDir);
      commitSha = stdout.trim();
    } catch (err) {
      console.warn("[developer] Nothing to commit — likely no changes were made.", err);
    }

    if (commitSha) {
      try {
        if (GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO) {
          const authRemote = `https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git`;
          await run("git", ["remote", "set-url", "origin", authRemote], worktreeDir);
        }
        await run("git", ["-c", "credential.helper=", "push", "-u", "origin", branch], worktreeDir);
      } catch (err) {
        console.warn("[developer] Push failed.", err);
      }

    }

    try {
      await run("git", ["worktree", "remove", worktreeDir], TARGET_REPO_PATH);
    } catch {
      console.warn(`[developer] Could not remove worktree at ${worktreeDir} — clean up manually.`);
    }
  } finally {
    releaseLock();
  }

  const [attempt] = await db
    .insert(fixAttempts)
    .values({
      ticketId,
      branch,
      commitSha,
      prUrl,
      developerAgentRunId: `dev-${Date.now()}`,
      attemptNumber,
    })
    .returning();

  await db.update(tickets).set({ status: "in_review" }).where(eq(tickets.id, ticketId));

  return { fixAttemptId: attempt.id, branch, prUrl };
}
