import "dotenv/config";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { tickets, fixAttempts } from "../db/schema.js";
import { run } from "../lib/exec.js";
import { openPullRequest } from "../integrations/github.js";
import { LABEL_PREFIX, LABEL_PREFIX_SLUG, DEVELOPER_MODEL, DEVELOPER_EFFORT } from "../lib/config.js";
import { buildPrompt } from "./prompt-builder.js";

const TARGET_REPO_PATH = process.env.TARGET_REPO_PATH ?? "";
const BASE_BRANCH = process.env.GITHUB_BASE_BRANCH ?? "master";

export interface DeveloperResult {
  fixAttemptId: string;
  branch: string;
  prUrl: string | null;
}

export async function runDeveloperAgent(ticketId: string): Promise<DeveloperResult> {
  if (!TARGET_REPO_PATH) throw new Error("TARGET_REPO_PATH is not set.");

  const existingAttempts = await db
    .select()
    .from(fixAttempts)
    .where(eq(fixAttempts.ticketId, ticketId));
  const attemptNumber = existingAttempts.length + 1;

  const shortId = ticketId.slice(0, 8);
  const branch = `${LABEL_PREFIX_SLUG}/${shortId}-attempt-${attemptNumber}`;
  const worktreeDir = join(TARGET_REPO_PATH, "..", `.worktrees`, branch.replace(/\//g, "-"));

  await run("git", ["worktree", "add", "-b", branch, worktreeDir, BASE_BRANCH], TARGET_REPO_PATH);

  const prompt = await buildPrompt(ticketId);

  // --- Claude Agent SDK call -------------------------------------------------
  // Verify this shape against the current docs (code.claude.com/docs/en/agent-sdk)
  // before running — this skill's cached knowledge doesn't cover the Agent SDK,
  // only the Claude API, so the exact option names below may have moved on.
  // Model/effort tiering: see lib/config.ts — Sonnet by default, override via
  // CLAUDE_DEVELOPER_MODEL/CLAUDE_DEVELOPER_EFFORT if a ticket needs Opus.
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("[developer] ANTHROPIC_API_KEY not set — skipping the actual fix, worktree left in place.");
  } else {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    for await (const message of query({
      prompt,
      options: {
        cwd: worktreeDir,
        allowedTools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
        permissionMode: "acceptEdits",
        model: DEVELOPER_MODEL,
        // "effort" may not be a supported top-level option on this SDK version —
        // verify against current docs; if rejected, drop it and control depth
        // via the prompt instead.
        effort: DEVELOPER_EFFORT,
      },
    } as any)) {
      // Surface agent progress to the console; swap for structured logging later.
      if ((message as any).type === "assistant") {
        console.log("[developer]", JSON.stringify((message as any).message?.content ?? message));
      }
    }
  }

  let commitSha: string | null = null;
  let prUrl: string | null = null;
  try {
    await run("git", ["add", "-A"], worktreeDir);
    await run("git", ["commit", "-m", `fix(${LABEL_PREFIX_SLUG}): ${branch}`], worktreeDir);
    const { stdout } = await run("git", ["rev-parse", "HEAD"], worktreeDir);
    commitSha = stdout.trim();
    await run("git", ["push", "-u", "origin", branch], worktreeDir);

    const pr = await openPullRequest({
      head: branch,
      base: BASE_BRANCH,
      title: `[${LABEL_PREFIX}] Fix: ${branch}`,
      body: `Automated accessibility fix for ticket ${ticketId} (attempt ${attemptNumber}).`,
      draft: true,
    });
    prUrl = pr?.url ?? null;
  } catch (err) {
    console.warn("[developer] Nothing to commit or push failed — likely no changes were made.", err);
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
