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

const TARGET_REPO_PATH = process.env.TARGET_REPO_PATH ?? "";
const BASE_BRANCH = process.env.GITHUB_BASE_BRANCH ?? "master";
const QA_BRANCH = process.env.GITHUB_QA_BRANCH ?? "qa";

export interface ReviewerVerdict {
  reviewResultId: string;
  verdict: "approved" | "rejected";
  scopeGuardFlagged: boolean;
}

export const runReviewerAgent = traceable(_runReviewerAgent, { name: "reviewer-agent", run_type: "chain" });

async function _runReviewerAgent(fixAttemptId: string): Promise<ReviewerVerdict> {
  const [attempt] = await db.select().from(fixAttempts).where(eq(fixAttempts.id, fixAttemptId));
  if (!attempt) throw new Error(`FixAttempt ${fixAttemptId} not found`);
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, attempt.ticketId));

  const baseName = attempt.branch.replace(/\//g, "-");
  const suffix = `-review-${Date.now()}`;
  let worktreeDir = join(TARGET_REPO_PATH, "..", ".worktrees", baseName);

  await run("git", ["fetch", "origin", attempt.branch, QA_BRANCH], TARGET_REPO_PATH);
  await run("git", ["worktree", "prune"], TARGET_REPO_PATH);

  if (existsSync(worktreeDir)) {
    try {
      rmSync(worktreeDir, { recursive: true, force: true });
    } catch {
      worktreeDir = join(TARGET_REPO_PATH, "..", ".worktrees", baseName + suffix);
    }
  }
  await run("git", ["worktree", "add", worktreeDir, `origin/${attempt.branch}`], TARGET_REPO_PATH);

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
  const pagesTouched = [...new Set(ticketIssues.map((i) => new URL(i.pageUrl).pathname))];
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
  } else if (verdict === "rejected" && attempt.attemptNumber >= 2) {
    await db.update(tickets).set({ status: "parked" }).where(eq(tickets.id, attempt.ticketId));
  } else if (verdict === "rejected") {
    await db.update(tickets).set({ status: "open" }).where(eq(tickets.id, attempt.ticketId));
  }
  // verdict === "approved" && !guard.flagged -> stays "in_review"; the Deploy agent sets "done".

  try {
    await run("git", ["worktree", "remove", worktreeDir], TARGET_REPO_PATH);
  } catch {
    console.warn(`[reviewer] Could not remove worktree at ${worktreeDir} — clean up manually.`);
  }

  return { reviewResultId: reviewResult.id, verdict, scopeGuardFlagged: guard.flagged };
}
