import "dotenv/config";
import { eq, inArray, desc } from "drizzle-orm";
import { traceable } from "langsmith/traceable";
import { db } from "../db/client.js";
import { fixAttempts, tickets, deployments, reviewResults } from "../db/schema.js";
import { getVcsProvider } from "../integrations/vcs/factory.js";
import { getTrackerProvider } from "../integrations/tracker/factory.js";
import { LABEL_PREFIX_SLUG } from "../lib/config.js";
import { resolveConflicts } from "./conflict-resolver.js";
import { logAudit } from "../lib/audit-log.js";

const QA_BRANCH = process.env.GITHUB_QA_BRANCH ?? "qa";

const vcs = getVcsProvider();
const tracker = getTrackerProvider();

async function postResolutionComment(
  jiraKey: string,
  opts: { branch: string; commitSha: string | null; tag: string | null; ticketId: string; prUrl?: string | null; mergeMethod?: string },
): Promise<void> {
  const attempts = await db
    .select()
    .from(fixAttempts)
    .where(eq(fixAttempts.ticketId, opts.ticketId));

  const resolvedIssueCount: number[] = [];
  const reviewComments: string[] = [];

  for (const attempt of attempts) {
    const [review] = await db
      .select()
      .from(reviewResults)
      .where(eq(reviewResults.fixAttemptId, attempt.id));
    if (review) {
      const ids = review.resolvedIssueIds as string[];
      resolvedIssueCount.push(ids.length);
      if (review.comments) reviewComments.push(review.comments);
    }
  }

  const totalResolved = resolvedIssueCount.reduce((a, b) => a + b, 0);
  const lines = [
    `Resolved via branch \`${opts.branch}\`.`,
    opts.prUrl ? `Pull request: ${opts.prUrl} (merged via ${opts.mergeMethod ?? "merge"})` : null,
    opts.commitSha ? `Merge commit: ${opts.commitSha}` : null,
    opts.tag ? `Rollback tag: ${opts.tag}` : null,
    totalResolved > 0 ? `Issues resolved: ${totalResolved}` : null,
    attempts.length > 1 ? `Fix attempts: ${attempts.length}` : null,
    reviewComments.length > 0 ? `\nReview notes:\n${reviewComments.join("\n")}` : null,
  ];

  await tracker.comment(jiraKey, lines.filter(Boolean).join("\n"));
}

export interface DeployResult {
  deploymentId: string | null;
  commitSha: string | null;
  tag: string | null;
}

/**
 * Confirms a ticket's fix actually resolved the issue, once the post-deploy
 * verification scan/triage pass finds none of its original fingerprints
 * still reproducing (see triage-from-reports.ts's verifyInReviewTickets).
 * This is the only place a ticket is marked "done" — merging to qa no longer
 * does this, since a merge alone doesn't prove the live site is fixed.
 */
export async function confirmTicketFixed(ticketId: string): Promise<void> {
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
  if (!ticket) return;

  await db.update(tickets).set({ status: "done" }).where(eq(tickets.id, ticketId));

  if (ticket.jiraKey) {
    const [latestAttempt] = await db
      .select()
      .from(fixAttempts)
      .where(eq(fixAttempts.ticketId, ticketId))
      .orderBy(desc(fixAttempts.createdAt))
      .limit(1);
    await postResolutionComment(ticket.jiraKey, {
      branch: latestAttempt?.branch ?? "unknown",
      commitSha: null,
      tag: null,
      ticketId,
    });
    await tracker.transitionTicket(ticket.jiraKey, "Done");
  }
}

export interface BranchDeployResult {
  deploymentId: string | null;
  commitSha: string | null;
  tag: string | null;
  ticketsDeployed: number;
  status: "succeeded" | "failed" | "blocked";
  blockReason?: string;
}

/**
 * Pre-merge validation: the branch's latest review must have approved with
 * no unresolved blocking findings (which folds in unmet acceptance criteria,
 * since an unmet-AC finding is itself a blocking finding). There's no PR to
 * check approval/mergeability against anymore — merge conflicts are instead
 * discovered (and retried once) when the direct branch merge is attempted.
 */
async function checkMergeReadiness(
  ticketIds: string[],
): Promise<{ ready: true } | { ready: false; reason: string }> {
  const attempts = await db.select().from(fixAttempts).where(inArray(fixAttempts.ticketId, ticketIds));
  const attemptIds = attempts.map((a) => a.id);

  let latestReview: typeof reviewResults.$inferSelect | undefined;
  if (attemptIds.length > 0) {
    const reviews = await db
      .select()
      .from(reviewResults)
      .where(inArray(reviewResults.fixAttemptId, attemptIds))
      .orderBy(desc(reviewResults.createdAt))
      .limit(1);
    latestReview = reviews[0];
  }

  if (!latestReview || latestReview.verdict !== "approved") {
    return { ready: false, reason: `Tests/review not in an approved state (verdict: ${latestReview?.verdict ?? "none"}).` };
  }

  if ((latestReview.blockingFindingsCount ?? 0) > 0) {
    return { ready: false, reason: `${latestReview.blockingFindingsCount} unresolved blocking review finding(s).` };
  }

  return { ready: true };
}

/**
 * Merges an approved fix into the qa integration branch and tags it for
 * rollback — per architecture doc §06: "redeploy the last-good tag" instead
 * of a git-archaeology exercise.
 */
export const runDeployAgent = traceable(_runDeployAgent, {
  name: "deploy.run",
  run_type: "chain",
  metadata: { node_kind: "orchestration" },
});

async function _runDeployAgent(fixAttemptId: string): Promise<DeployResult> {
  const [attempt] = await db.select().from(fixAttempts).where(eq(fixAttempts.id, fixAttemptId));
  if (!attempt) throw new Error(`FixAttempt ${fixAttemptId} not found`);

  if (attempt.pushStatus !== "pushed") {
    console.error(`[deploy] FixAttempt ${fixAttemptId} was never pushed to remote (status: ${attempt.pushStatus}). Cannot merge.`);
    const [deployment] = await db
      .insert(deployments)
      .values({ env: QA_BRANCH, commitSha: "none", tag: null, status: "failed" })
      .returning();
    return { deploymentId: deployment.id, commitSha: null, tag: null };
  }

  const [review] = await db.select().from(reviewResults).where(eq(reviewResults.fixAttemptId, fixAttemptId));
  if (!review || review.verdict !== "approved" || review.scopeGuardFlagged) {
    const reason = !review ? "no review result" : review.scopeGuardFlagged ? "scope-flagged for manual review" : `verdict: ${review.verdict}`;
    console.warn(`[deploy] FixAttempt ${fixAttemptId} not cleared for merge — ${reason}.`);
    const [deployment] = await db
      .insert(deployments)
      .values({ env: QA_BRANCH, commitSha: "none", tag: null, status: "failed" })
      .returning();
    return { deploymentId: deployment.id, commitSha: null, tag: null };
  }

  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, attempt.ticketId));
  const jiraRef = ticket?.jiraKey ? ` [${ticket.jiraKey}]` : "";

  let commitSha: string | null = null;
  try {
    commitSha = await vcs.mergeBranch(
      attempt.branch,
      QA_BRANCH,
      `fix(${LABEL_PREFIX_SLUG}):${jiraRef} merge ${attempt.branch} into ${QA_BRANCH}`,
    );
  } catch (err) {
    const errMsg = (err as Error).message;
    const isConflict = vcs.isConflictError(err as Error);

    if (isConflict) {
      console.warn(`[deploy] Merge conflict detected for ${attempt.branch}${jiraRef} — invoking conflict resolver...`);
      try {
        const resolution = await resolveConflicts(fixAttemptId);
        if (resolution.resolved) {
          console.log(`[deploy] Conflicts resolved for ${attempt.branch} — retrying merge...`);
          commitSha = await vcs.mergeBranch(
            attempt.branch,
            QA_BRANCH,
            `fix(${LABEL_PREFIX_SLUG}):${jiraRef} merge ${attempt.branch} into ${QA_BRANCH} (conflicts resolved)`,
          );
        } else {
          console.error(`[deploy] Conflict resolver could not resolve conflicts for ${attempt.branch} (files: ${resolution.conflictFiles.join(", ")})`);
        }
      } catch (resolveErr) {
        console.error(`[deploy] Conflict resolution failed for ${attempt.branch}: ${(resolveErr as Error).message}`);
      }
    }

    if (!commitSha) {
      console.error(`[deploy] GitHub merge failed for ${attempt.branch}: ${errMsg}`);
      if (ticket?.jiraKey) {
        await tracker.transitionTicket(ticket.jiraKey, "To Do");
      }
      await db.update(tickets).set({ status: "open" }).where(eq(tickets.id, attempt.ticketId));
      const [deployment] = await db
        .insert(deployments)
        .values({ env: QA_BRANCH, commitSha: "none", tag: null, status: "failed" })
        .returning();
      return { deploymentId: deployment.id, commitSha: null, tag: null };
    }
  }
  if (!commitSha) {
    console.warn(`[deploy] Merge did not return a commit sha — GitHub may not be configured or branch is missing.`);
  }

  let tag: string | null = null;
  if (commitSha) {
    tag = `${LABEL_PREFIX_SLUG}-${QA_BRANCH}-${commitSha.slice(0, 7)}`;
    await vcs.createTag(tag, commitSha);
  }

  // Actual QA deploy is expected to be triggered by your existing CI/CD on push
  // to the qa branch (GitHub Actions etc.) — the merge above is what fires it.
  const [deployment] = await db
    .insert(deployments)
    .values({
      env: QA_BRANCH,
      commitSha: commitSha ?? "unknown",
      tag,
      status: commitSha ? "succeeded" : "failed",
    })
    .returning();

  await db.update(tickets).set({ status: "done" }).where(eq(tickets.id, attempt.ticketId));

  if (ticket?.jiraKey) {
    await postResolutionComment(ticket.jiraKey, {
      branch: attempt.branch,
      commitSha,
      tag,
      ticketId: attempt.ticketId,
    });
    await tracker.transitionTicket(ticket.jiraKey, "Done");
  }

  return { deploymentId: deployment.id, commitSha, tag };
}

/**
 * Merge a reviewed shared branch containing fixes for multiple tickets
 * directly into QA (no PR — reviewer-agent.ts's reviewBranch already reviews
 * the branch diff without needing one). Runs the pre-merge checklist first;
 * on a conflict, brings the branch up to date from QA and retries once.
 * Tickets stay "in_review" on success — merging alone doesn't prove the live
 * site is fixed, so "done" is only set once the post-deploy verification
 * scan confirms it (see triage-from-reports.ts).
 */
export const deployBranch = traceable(_deployBranch, {
  name: "deploy.merge_branch",
  run_type: "chain",
  metadata: { node_kind: "orchestration" },
});

async function _deployBranch(
  branch: string,
  ticketIds: string[],
  cycleId?: string,
): Promise<BranchDeployResult> {
  const allTickets = await db.select().from(tickets).where(
    inArray(tickets.id, ticketIds),
  );
  const jiraKeys = allTickets.map((t) => t.jiraKey).filter(Boolean);
  const jiraRef = jiraKeys.length > 0 ? ` [${jiraKeys.join(", ")}]` : "";

  const readiness = await checkMergeReadiness(ticketIds);
  if (!readiness.ready) {
    console.warn(`[deploy] Branch ${branch}${jiraRef} not ready to merge — ${readiness.reason}`);
    if (cycleId) {
      await logAudit({
        cycleId,
        action: "branch.merge_blocked",
        actor: "deploy",
        entityType: "branch",
        entityId: branch,
        details: { reason: readiness.reason },
        status: "failure",
      });
    }
    const [deployment] = await db
      .insert(deployments)
      .values({ env: QA_BRANCH, commitSha: "none", tag: null, status: "blocked" })
      .returning();
    return { deploymentId: deployment.id, commitSha: null, tag: null, ticketsDeployed: 0, status: "blocked", blockReason: readiness.reason };
  }

  let commitSha: string | null = null;
  try {
    commitSha = await vcs.mergeBranch(branch, QA_BRANCH, `fix(${LABEL_PREFIX_SLUG}):${jiraRef} merge ${branch} into ${QA_BRANCH}`);
  } catch (err) {
    const errMsg = (err as Error).message;
    const isConflict = vcs.isConflictError(err as Error);

    if (isConflict) {
      console.warn(`[deploy] Merge conflict for ${branch}${jiraRef} — updating branch from ${QA_BRANCH} and retrying once...`);
      try {
        await vcs.updateBranchFromBase(branch, QA_BRANCH);
        commitSha = await vcs.mergeBranch(branch, QA_BRANCH, `fix(${LABEL_PREFIX_SLUG}):${jiraRef} merge ${branch} into ${QA_BRANCH} (conflicts resolved)`);
      } catch (resolveErr) {
        console.error(`[deploy] Conflict resolution failed: ${(resolveErr as Error).message}`);
      }
    } else {
      console.error(`[deploy] Merge failed for ${branch}${jiraRef}: ${errMsg}`);
    }
  }

  if (!commitSha) {
    for (const t of allTickets) {
      if (t.jiraKey) await tracker.transitionTicket(t.jiraKey, "To Do");
      await db.update(tickets).set({ status: "open" }).where(eq(tickets.id, t.id));
    }
    if (cycleId) {
      await logAudit({
        cycleId,
        action: "branch.merge_failed",
        actor: "deploy",
        entityType: "branch",
        entityId: branch,
        details: {},
        status: "failure",
      });
    }
    const [deployment] = await db
      .insert(deployments)
      .values({ env: QA_BRANCH, commitSha: "none", tag: null, status: "failed" })
      .returning();
    return { deploymentId: deployment.id, commitSha: null, tag: null, ticketsDeployed: 0, status: "failed" };
  }

  const tag = `${LABEL_PREFIX_SLUG}-${QA_BRANCH}-${commitSha.slice(0, 7)}`;
  await vcs.createTag(tag, commitSha);

  const [deployment] = await db
    .insert(deployments)
    .values({
      env: QA_BRANCH,
      commitSha,
      tag,
      status: "succeeded",
    })
    .returning();

  if (cycleId) {
    await logAudit({
      cycleId,
      action: "branch.merged",
      actor: "deploy",
      entityType: "branch",
      entityId: branch,
      details: { commitSha, tag, ticketsDeployed: allTickets.length },
      status: "success",
    });
  }

  // Merged and awaiting the post-deploy verification scan — reflect that on
  // the tracker so a ticket doesn't sit visibly "In Progress" all the way
  // through to "Done" with no indication it's mid-verification.
  for (const t of allTickets) {
    if (t.jiraKey) {
      try {
        await tracker.transitionTicket(t.jiraKey, "In Review");
      } catch (err) {
        console.warn(`[deploy] Failed to transition ${t.jiraKey} to In Review:`, (err as Error).message?.slice(0, 200));
      }
    }
  }

  console.log(`[deploy] Merged ${branch} into ${QA_BRANCH} — ${allTickets.length} ticket(s) awaiting live verification.`);
  return { deploymentId: deployment.id, commitSha, tag, ticketsDeployed: allTickets.length, status: "succeeded" };
}
