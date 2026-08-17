import "dotenv/config";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { eq, inArray, desc } from "drizzle-orm";
import { traceable } from "langsmith/traceable";
import { db } from "../db/client.js";
import { fixAttempts, tickets, issues, reviewResults } from "../db/schema.js";
import { run } from "../lib/exec.js";
import { scopeGuard } from "./scope-guard.js";
import { testGate } from "./test-gate.js";
import { adversarialReview, type ReviewFinding } from "./adversarial-review.js";
import { startEphemeralPreview } from "./ephemeral-preview.js";
import { runAxeScan, fingerprintFinding } from "../scan/axe-scan.js";
import { getTrackerProvider } from "../integrations/tracker/factory.js";
import { getVcsProvider } from "../integrations/vcs/factory.js";
import type { PrReviewComment } from "../integrations/vcs/types.js";
import { gitRepoMutex } from "../lib/mutex.js";
import { redactSecrets } from "../observability/sanitize.js";
import { logAudit } from "../lib/audit-log.js";

const TARGET_REPO_PATH = process.env.TARGET_REPO_PATH ?? "";
const QA_BRANCH = process.env.GITHUB_QA_BRANCH ?? "qa";

const tracker = getTrackerProvider();
const vcs = getVcsProvider();

export interface ReviewerVerdict {
  reviewResultId: string;
  verdict: "approved" | "rejected";
  scopeGuardFlagged: boolean;
}

export interface BranchReviewVerdict {
  verdict: "approved" | "rejected";
  scopeGuardFlagged: boolean;
  comments: string;
  findings: ReviewFinding[];
  blockingFindingsCount: number;
  prReviewId: string | null;
}

function findingToComment(f: ReviewFinding): PrReviewComment | null {
  if (!f.file || !f.line) return null;
  const prefix = f.severity === "blocking" ? "🚫 BLOCKING" : "💡 Suggestion";
  return { path: f.file, line: f.line, side: "RIGHT", body: `**${prefix} (${f.category})**\n\n${redactSecrets(f.message)}` };
}

function summarizeFindings(findings: ReviewFinding[]): string {
  if (findings.length === 0) return "No issues found.";
  return findings
    .map((f) => `- [${f.severity.toUpperCase()}/${f.category}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} — ` : ""}${redactSecrets(f.message)}`)
    .join("\n");
}

async function acceptanceCriteriaFor(ticketId: string): Promise<string | undefined> {
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
  if (!ticket) return undefined;
  const ticketIssues = await db.select().from(issues).where(inArray(issues.id, (ticket.issueIds as string[] | null) ?? []));
  if (ticketIssues.length === 0) return undefined;
  return ticketIssues.map((i) => `- ${i.wcagRule} at ${i.selector} on ${i.pageUrl} (severity: ${i.severity})`).join("\n");
}

export const runReviewerAgent = traceable(_runReviewerAgent, {
  name: "reviewer.run",
  run_type: "chain",
  metadata: { node_kind: "orchestration" },
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
  const findings = await adversarialReview(worktreeDir, await acceptanceCriteriaFor(attempt.ticketId));
  const blockingFindingsCount = findings.filter((f) => f.severity === "blocking").length;

  // Verdict: build/lint/test failures AND blocking review findings are hard blockers.
  // Re-scan is non-blocking when unavailable.
  const rescanPassed = rescanSkipped || stillFailing.length === 0;
  const verdict: "approved" | "rejected" =
    tests.passed && rescanPassed && blockingFindingsCount === 0 ? "approved" : "rejected";

  if (findings.length > 0) {
    console.warn(`[reviewer] Adversarial review findings (${blockingFindingsCount} blocking):`, summarizeFindings(findings).slice(0, 500));
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
    `Adversarial review: ${summarizeFindings(findings)}`,
  ].join("\n");

  const [reviewResult] = await db
    .insert(reviewResults)
    .values({
      fixAttemptId,
      verdict,
      resolvedIssueIds,
      scopeGuardFlagged: guard.flagged,
      comments,
      findings,
      blockingFindingsCount,
    })
    .returning();

  // Ticket status transition — see architecture doc §01/§06 for the park/flag rules.
  if (verdict === "approved" && guard.flagged) {
    await db.update(tickets).set({ status: "flagged" }).where(eq(tickets.id, attempt.ticketId));
    if (ticket?.jiraKey) await tracker.transitionTicket(ticket.jiraKey, "In Review");
  } else if (verdict === "rejected" && attempt.attemptNumber >= 2) {
    await db.update(tickets).set({ status: "parked" }).where(eq(tickets.id, attempt.ticketId));
    if (ticket?.jiraKey) await tracker.transitionTicket(ticket.jiraKey, "To Do");
  } else if (verdict === "rejected") {
    await db.update(tickets).set({ status: "open" }).where(eq(tickets.id, attempt.ticketId));
    if (ticket?.jiraKey) await tracker.transitionTicket(ticket.jiraKey, "To Do");
  } else if (verdict === "approved") {
    // Clean approval — stays "in_review" in DB; Deploy agent sets "done".
    if (ticket?.jiraKey) await tracker.transitionTicket(ticket.jiraKey, "In Review");
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
 * Review all changes on a shared branch at once, against a PR. The worktree
 * already exists and contains all ticket fixes as separate commits. Runs
 * scope guard, build/lint/test gate, and adversarial review on the full diff,
 * then posts line-level comments for every finding to the PR (both
 * severities) — only "blocking" findings gate the verdict.
 */
export const reviewBranch = traceable(_reviewBranch, {
  name: "reviewer.review_branch",
  run_type: "chain",
  metadata: { node_kind: "orchestration" },
});

async function _reviewBranch(
  worktreeDir: string,
  ticketIds: string[],
  prNumber: number | null,
  cycleId?: string,
): Promise<BranchReviewVerdict> {
  const { stdout: nameOnly } = await run("git", ["diff", "--name-only", `origin/${QA_BRANCH}`], worktreeDir);
  const touchedFiles = nameOnly.trim().split("\n").filter(Boolean);

  console.log(`[reviewer] Branch review — ${touchedFiles.length} changed file(s) across ${ticketIds.length} ticket(s)`);

  if (touchedFiles.length === 0) {
    console.warn("[reviewer] No files changed on branch — nothing to review.");
    return { verdict: "rejected", scopeGuardFlagged: false, comments: "No files changed on the branch.", findings: [], blockingFindingsCount: 0, prReviewId: null };
  }

  const guard = await scopeGuard(worktreeDir);
  const tests = await testGate(worktreeDir, touchedFiles);
  console.log(`[reviewer] Build/lint/test gate: ${tests.passed ? "PASSED" : "FAILED"} — ${tests.output}`);

  // Combine acceptance criteria across all tickets in this batch.
  const acCriteria = (await Promise.all(ticketIds.map(acceptanceCriteriaFor))).filter(Boolean).join("\n");
  const findings = await adversarialReview(worktreeDir, acCriteria || undefined);
  const blockingFindingsCount = findings.filter((f) => f.severity === "blocking").length;

  const verdict: "approved" | "rejected" = tests.passed && blockingFindingsCount === 0 ? "approved" : "rejected";

  if (findings.length > 0) {
    console.warn(`[reviewer] Adversarial review findings (${blockingFindingsCount} blocking):`, summarizeFindings(findings).slice(0, 500));
  }

  const comments = [
    `Build/lint/test gate: ${tests.passed ? "PASSED" : "FAILED"} — ${tests.output}`,
    guard.flagged ? `Scope guard: FLAGGED — ${guard.reason}` : "Scope guard: clear",
    `Adversarial review: ${summarizeFindings(findings)}`,
    `Tickets reviewed: ${ticketIds.length}`,
    `Files changed: ${touchedFiles.length}`,
  ].join("\n");

  // Post line-level comments for every finding (both severities); only
  // blocking ones gate the verdict above.
  let prReviewId: string | null = null;
  if (prNumber != null && findings.length > 0) {
    const prComments = findings.map(findingToComment).filter((c): c is NonNullable<typeof c> => c !== null);
    try {
      prReviewId = await vcs.addReviewComments(prNumber, prComments);
    } catch (err) {
      console.warn(`[reviewer] Failed to post PR review comments for PR #${prNumber}:`, (err as Error).message?.slice(0, 200));
    }
    if (cycleId) {
      await logAudit({
        cycleId,
        action: "pr.review_comments_posted",
        actor: "reviewer",
        entityType: "pull_request",
        entityId: String(prNumber),
        details: { findingCount: findings.length, blockingFindingsCount },
        status: "success",
      });
    }
  }

  // Persist one review_results row per ticket's latest fix_attempts row —
  // deploy-agent's merge-readiness checklist independently re-queries these
  // tables rather than trusting in-memory graph state, so without this a
  // merge can never be confirmed "approved" and would block forever.
  for (const ticketId of ticketIds) {
    const [latestAttempt] = await db
      .select()
      .from(fixAttempts)
      .where(eq(fixAttempts.ticketId, ticketId))
      .orderBy(desc(fixAttempts.createdAt))
      .limit(1);
    if (!latestAttempt) {
      console.warn(`[reviewer] No fix_attempts row found for ticket ${ticketId.slice(0, 8)} — skipping review_results persistence.`);
      continue;
    }
    await db.insert(reviewResults).values({
      fixAttemptId: latestAttempt.id,
      verdict,
      resolvedIssueIds: [],
      scopeGuardFlagged: guard.flagged,
      comments,
      findings,
      blockingFindingsCount,
      prReviewId,
    });
  }

  return { verdict, scopeGuardFlagged: guard.flagged, comments, findings, blockingFindingsCount, prReviewId };
}
