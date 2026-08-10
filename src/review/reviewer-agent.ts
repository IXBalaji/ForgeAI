import "dotenv/config";
import { join } from "node:path";
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

  const worktreeDir = join(TARGET_REPO_PATH, "..", ".worktrees", attempt.branch.replace(/\//g, "-"));

  const { stdout: nameOnly } = await run("git", ["diff", "--name-only", BASE_BRANCH], worktreeDir);
  const touchedFiles = nameOnly.trim().split("\n").filter(Boolean);

  const guard = await scopeGuard(worktreeDir);
  const tests = await testGate(worktreeDir, touchedFiles);

  const ticketIssues = await db.select().from(issues).where(inArray(issues.id, (ticket?.issueIds as string[]) ?? []));

  // Targeted re-scan against an ephemeral preview of THIS branch — not the
  // shared TARGET_FRONTEND_URL, which could be running anything. No DB writes
  // here (unlike the old scanner-agent-based approach): fingerprints are
  // compared in memory, so a review can never overwrite an Issue's
  // scan_run_id the way the earlier implementation did.
  const pagesTouched = [...new Set(ticketIssues.map((i) => new URL(i.pageUrl).pathname))];
  let resolvedIssueIds: string[] = [];
  let stillFailing: string[] = [];
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
    console.warn("[reviewer] Targeted re-scan failed to run — treating as unresolved.", err);
    stillFailing = ticketIssues.map((i) => i.id);
  }

  const llmConcern = await adversarialReview(worktreeDir);

  const verdict: "approved" | "rejected" =
    tests.passed && stillFailing.length === 0 && !llmConcern ? "approved" : "rejected";

  const comments = [
    `Test gate: ${tests.passed ? "passed" : "FAILED"} — ${tests.output}`,
    `Targeted re-scan (ephemeral preview): ${stillFailing.length === 0 ? "all instances resolved" : `${stillFailing.length} instance(s) still failing`}`,
    guard.flagged ? `Scope guard: FLAGGED — ${guard.reason}` : "Scope guard: clear",
    llmConcern ? `Adversarial review: FLAGGED — ${llmConcern}` : "Adversarial review: LGTM",
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

  return { reviewResultId: reviewResult.id, verdict, scopeGuardFlagged: guard.flagged };
}
