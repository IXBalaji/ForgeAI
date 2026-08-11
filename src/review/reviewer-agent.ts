import "dotenv/config";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { traceable } from "langsmith/traceable";
import { db } from "../db/client.js";
import { fixAttempts, tickets, issues, reviewResults } from "../db/schema.js";
import { run } from "../lib/exec.js";
import { scopeGuard } from "./scope-guard.js";
import { testGate } from "./test-gate.js";
import { adversarialReview } from "./adversarial-review.js";
import { startEphemeralPreview } from "./ephemeral-preview.js";
import { runAxeScan, fingerprintFinding } from "../scan/axe-scan.js";
import { transitionTicket } from "../integrations/jira.js";
import { gitRepoMutex } from "../lib/mutex.js";

const TARGET_REPO_PATH = process.env.TARGET_REPO_PATH ?? "";
const BASE_BRANCH = process.env.GITHUB_BASE_BRANCH ?? "qa";
const QA_BRANCH = process.env.GITHUB_QA_BRANCH ?? "qa";

export interface ReviewerVerdict {
  reviewResultId: string;
  verdict: "approved" | "rejected";
  scopeGuardFlagged: boolean;
}

export interface BranchReviewVerdict {
  verdict: "approved" | "rejected";
  scopeGuardFlagged: boolean;
  comments: string;
}

export const runReviewerAgent = traceable(_runReviewerAgent, {
  name: "reviewer.run",
  run_type: "chain",
  metadata: { model: "orchestrator" },
});

async function _runReviewerAgent(fixAttemptId: string): Promise<ReviewerVerdict> {
  const [attempt] = await db.select().from(fixAttempts).where(eq(fixAttempts.id, fixAttemptId));
  if (!attempt) throw new Error(`FixAttempt ${fixAttemptId} not found`);
  if (attempt.pushStatus !== "pushed") {
    console.warn(`[reviewer] FixAttempt ${fixAttemptId} pushStatus is "${attempt.pushStatus}" — branch may only exist locally.`);
  }
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, attempt.ticketId));
  if (!ticket) {
    console.error(`[reviewer] Ticket ${attempt.ticketId} not found — rejecting fix attempt.`);
    const [reviewResult] = await db
      .insert(reviewResults)
      .values({ fixAttemptId, verdict: "rejected", resolvedIssueIds: [], scopeGuardFlagged: false, comments: `Ticket ${attempt.ticketId} not found in database.` })
      .returning();
    return { reviewResultId: reviewResult.id, verdict: "rejected" as const, scopeGuardFlagged: false };
  }

  const baseName = attempt.branch.replace(/\//g, "-");
  const suffix = `-review-${Date.now()}`;
  let worktreeDir = join(TARGET_REPO_PATH, "..", ".worktrees", baseName);

  // Serialize git operations — git holds a repo-level lock
  let releaseLock = await gitRepoMutex.acquire();
  try {
    try {
      await run("git", ["fetch", "origin", QA_BRANCH], TARGET_REPO_PATH);
    } catch (err) {
      console.error(`[reviewer] git fetch failed: ${(err as Error).message}`);
      const [reviewResult] = await db
        .insert(reviewResults)
        .values({ fixAttemptId, verdict: "rejected", resolvedIssueIds: [], scopeGuardFlagged: false, comments: `git fetch failed: ${(err as Error).message.slice(0, 500)}` })
        .returning();
      return { reviewResultId: reviewResult.id, verdict: "rejected" as const, scopeGuardFlagged: false };
    }

    // Try fetching fix branch from remote; it may only exist locally if push failed
    let branchRef = `origin/${attempt.branch}`;
    try {
      await run("git", ["fetch", "origin", attempt.branch], TARGET_REPO_PATH);
    } catch {
      // Check if the branch exists locally
      try {
        await run("git", ["rev-parse", "--verify", attempt.branch], TARGET_REPO_PATH);
        branchRef = attempt.branch;
        console.log(`[reviewer] Branch ${attempt.branch} not on remote — using local ref.`);
      } catch {
        console.error(`[reviewer] Branch ${attempt.branch} not found locally or on remote.`);
        const [reviewResult] = await db
          .insert(reviewResults)
          .values({ fixAttemptId, verdict: "rejected", resolvedIssueIds: [], scopeGuardFlagged: false, comments: `Branch ${attempt.branch} not found locally or on remote.` })
          .returning();
        return { reviewResultId: reviewResult.id, verdict: "rejected" as const, scopeGuardFlagged: false };
      }
    }

    await run("git", ["worktree", "prune"], TARGET_REPO_PATH).catch(() => {});

    if (existsSync(worktreeDir)) {
      try {
        await run("git", ["worktree", "remove", worktreeDir, "--force"], TARGET_REPO_PATH);
      } catch {
        try { rmSync(worktreeDir, { recursive: true, force: true }); } catch {
          worktreeDir = join(TARGET_REPO_PATH, "..", ".worktrees", baseName + suffix);
        }
      }
    }

    try {
      await run("git", ["worktree", "add", worktreeDir, branchRef], TARGET_REPO_PATH);
    } catch (err) {
      console.error(`[reviewer] git worktree add failed: ${(err as Error).message}`);
      const [reviewResult] = await db
        .insert(reviewResults)
        .values({ fixAttemptId, verdict: "rejected", resolvedIssueIds: [], scopeGuardFlagged: false, comments: `git worktree add failed: ${(err as Error).message.slice(0, 500)}` })
        .returning();
      return { reviewResultId: reviewResult.id, verdict: "rejected" as const, scopeGuardFlagged: false };
    }
  } finally {
    releaseLock();
  }

  const { stdout: nameOnly } = await run("git", ["diff", "--name-only", `origin/${QA_BRANCH}`], worktreeDir);
  const touchedFiles = nameOnly.trim().split("\n").filter(Boolean);

  console.log(`[reviewer] Changed files (${touchedFiles.length}):`, touchedFiles.join(", "));

  if (touchedFiles.length === 0) {
    console.warn("[reviewer] No files changed — nothing to review.");
    const [reviewResult] = await db
      .insert(reviewResults)
      .values({ fixAttemptId, verdict: "rejected", resolvedIssueIds: [], scopeGuardFlagged: false, comments: "No files changed in the fix attempt." })
      .returning();
    try { await run("git", ["worktree", "remove", worktreeDir], TARGET_REPO_PATH); } catch {}
    return { reviewResultId: reviewResult.id, verdict: "rejected" as const, scopeGuardFlagged: false };
  }

  const guard = await scopeGuard(worktreeDir);
  const tests = await testGate(worktreeDir, touchedFiles);

  console.log(`[reviewer] Build/lint/test gate: ${tests.passed ? "PASSED" : "FAILED"} — ${tests.output}`);

  const ticketIssues = await db.select().from(issues).where(inArray(issues.id, (ticket?.issueIds as string[]) ?? []));

  // Targeted re-scan — non-blocking; ephemeral preview may not be available
  const pagesTouched = [...new Set(ticketIssues.map((i) => {
    try { return new URL(i.pageUrl).pathname; }
    catch { return i.pageUrl; }
  }).filter(Boolean))];
  let resolvedIssueIds: string[] = [];
  let stillFailing: string[] = [];
  let rescanSkipped = false;
  try {
    const preview = await startEphemeralPreview(worktreeDir);
    try {
      const freshFindings = await runAxeScan(preview.url, pagesTouched);
      const freshFingerprints = new Set(freshFindings.map(fingerprintFinding));
      for (const original of ticketIssues) {
        if (freshFingerprints.has(original.fingerprint)) stillFailing.push(original.id);
        else resolvedIssueIds.push(original.id);
      }
    } finally {
      await preview.stop();
    }
  } catch (err) {
    console.warn("[reviewer] Ephemeral re-scan unavailable — skipping (non-blocking).", err);
    rescanSkipped = true;
  }

  // Adversarial review — focuses only on changed lines
  const llmConcern = await adversarialReview(worktreeDir);

  // Verdict: only build/lint/test failures are hard blockers.
  // Adversarial review is advisory — logged but doesn't block.
  // Re-scan is non-blocking when unavailable.
  const rescanPassed = rescanSkipped || stillFailing.length === 0;
  const verdict: "approved" | "rejected" =
    tests.passed && rescanPassed ? "approved" : "rejected";

  if (llmConcern) {
    console.warn("[reviewer] Adversarial review concern (advisory, not blocking):", llmConcern.slice(0, 300));
  }

  const rescanStatus = rescanSkipped
    ? "SKIPPED (preview unavailable — non-blocking)"
    : stillFailing.length === 0
      ? "all instances resolved"
      : `${stillFailing.length} instance(s) still failing`;

  const comments = [
    `Build/lint/test gate: ${tests.passed ? "PASSED" : "FAILED"} — ${tests.output}`,
    `Targeted re-scan: ${rescanStatus}`,
    guard.flagged ? `Scope guard: FLAGGED — ${guard.reason}` : "Scope guard: clear",
    llmConcern ? `Adversarial review (advisory): ${llmConcern.slice(0, 500)}` : "Adversarial review: LGTM",
  ].join("\n");

  const [reviewResult] = await db
    .insert(reviewResults)
    .values({
      fixAttemptId,
      verdict,
      resolvedIssueIds,
      scopeGuardFlagged: guard.flagged,
      comments,
    })
    .returning();

  // Ticket status transition — see architecture doc §01/§06 for the park/flag rules.
  if (verdict === "approved" && guard.flagged) {
    await db.update(tickets).set({ status: "flagged" }).where(eq(tickets.id, attempt.ticketId));
    if (ticket?.jiraKey) await transitionTicket(ticket.jiraKey, "In Review");
  } else if (verdict === "rejected" && attempt.attemptNumber >= 2) {
    await db.update(tickets).set({ status: "parked" }).where(eq(tickets.id, attempt.ticketId));
    if (ticket?.jiraKey) await transitionTicket(ticket.jiraKey, "To Do");
  } else if (verdict === "rejected") {
    await db.update(tickets).set({ status: "open" }).where(eq(tickets.id, attempt.ticketId));
    if (ticket?.jiraKey) await transitionTicket(ticket.jiraKey, "To Do");
  } else if (verdict === "approved") {
    // Clean approval — stays "in_review" in DB; Deploy agent sets "done".
    if (ticket?.jiraKey) await transitionTicket(ticket.jiraKey, "In Review");
  }

  releaseLock = await gitRepoMutex.acquire();
  try {
    await run("git", ["worktree", "remove", worktreeDir], TARGET_REPO_PATH);
  } catch {
    console.warn(`[reviewer] Could not remove worktree at ${worktreeDir} — clean up manually.`);
  } finally {
    releaseLock();
  }

  return { reviewResultId: reviewResult.id, verdict, scopeGuardFlagged: guard.flagged };
}

/**
 * Review all changes on a shared branch at once. The worktree already exists
 * and contains all ticket fixes as separate commits. Runs scope guard, build/
 * lint/test gate, and adversarial review on the full diff.
 */
export const reviewBranch = traceable(_reviewBranch, {
  name: "reviewer.review_branch",
  run_type: "chain",
  metadata: { model: "orchestrator" },
});

async function _reviewBranch(
  worktreeDir: string,
  ticketIds: string[],
): Promise<BranchReviewVerdict> {
  const { stdout: nameOnly } = await run("git", ["diff", "--name-only", `origin/${QA_BRANCH}`], worktreeDir);
  const touchedFiles = nameOnly.trim().split("\n").filter(Boolean);

  console.log(`[reviewer] Branch review — ${touchedFiles.length} changed file(s) across ${ticketIds.length} ticket(s)`);

  if (touchedFiles.length === 0) {
    console.warn("[reviewer] No files changed on branch — nothing to review.");
    return { verdict: "rejected", scopeGuardFlagged: false, comments: "No files changed on the branch." };
  }

  const guard = await scopeGuard(worktreeDir);
  const tests = await testGate(worktreeDir, touchedFiles);
  console.log(`[reviewer] Build/lint/test gate: ${tests.passed ? "PASSED" : "FAILED"} — ${tests.output}`);

  const llmConcern = await adversarialReview(worktreeDir);

  const verdict: "approved" | "rejected" = tests.passed ? "approved" : "rejected";

  if (llmConcern) {
    console.warn("[reviewer] Adversarial review concern (advisory, not blocking):", llmConcern.slice(0, 300));
  }

  const comments = [
    `Build/lint/test gate: ${tests.passed ? "PASSED" : "FAILED"} — ${tests.output}`,
    guard.flagged ? `Scope guard: FLAGGED — ${guard.reason}` : "Scope guard: clear",
    llmConcern ? `Adversarial review (advisory): ${llmConcern.slice(0, 500)}` : "Adversarial review: LGTM",
    `Tickets reviewed: ${ticketIds.length}`,
    `Files changed: ${touchedFiles.length}`,
  ].join("\n");

  return { verdict, scopeGuardFlagged: guard.flagged, comments };
}
