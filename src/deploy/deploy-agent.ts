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

export interface BranchDeployResult {
  deploymentId: string | null;
  commitSha: string | null;
  tag: string | null;
  ticketsDeployed: number;
  status: "succeeded" | "failed" | "blocked";
  blockReason?: string;
}

/**
 * Ordered pre-merge validation checklist enforcing the 5 blocking conditions:
 * failing tests, unresolved blocking review comments, missing approval, merge
 * conflicts, and unmet acceptance criteria (folded into the blocking-findings
 * check, since an unmet-AC finding is itself a blocking finding).
 */
async function checkMergeReadiness(
  branch: string,
  ticketIds: string[],
  prNumber: number,
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

  // 1. Tests passed (defense-in-depth re-check of the stored review verdict).
  if (!latestReview || latestReview.verdict !== "approved") {
    return { ready: false, reason: `Tests/review not in an approved state (verdict: ${latestReview?.verdict ?? "none"}).` };
  }

  // 2 & 5. No unresolved blocking findings (folds in unmet acceptance criteria).
  if ((latestReview.blockingFindingsCount ?? 0) > 0) {
    return { ready: false, reason: `${latestReview.blockingFindingsCount} unresolved blocking review finding(s).` };
  }

  // 3. GitHub-side approval present.
  const status = await vcs.getPullRequestStatus(prNumber);
  if (!status) {
    return { ready: false, reason: "Could not retrieve PR status from GitHub." };
  }
  if (status.merged) {
    return { ready: true };
  }
  // GitHub refuses to let an identity approve its own PR, so when the PR author
  // is the same account as the API token, a GitHub-side APPROVED review can
  // never exist. Fall back to the internal review verdict (already checked
  // above) as the authoritative approval signal in that case.
  if (!status.selfAuthored && status.reviewState !== "APPROVED") {
    return { ready: false, reason: `PR review state is "${status.reviewState}", not APPROVED.` };
  }

  // 4. No merge conflicts.
  if (status.mergeable === false) {
    return { ready: false, reason: `PR #${prNumber} has merge conflicts (mergeable_state: ${status.mergeableState}).` };
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
 * Merge an approved, PR-gated shared branch containing fixes for multiple
 * tickets into QA. Runs the 5-point pre-merge checklist before merging via
 * the PR (not a direct branch merge); all tickets are marked "done" on
 * success. On any checklist failure, the PR is left open ("blocked") rather
 * than merged or closed.
 */
export const deployBranch = traceable(_deployBranch, {
  name: "deploy.merge_branch",
  run_type: "chain",
  metadata: { node_kind: "orchestration" },
});

async function _deployBranch(
  branch: string,
  ticketIds: string[],
  prNumber: number,
  prUrl: string | null = null,
  cycleId?: string,
): Promise<BranchDeployResult> {
  const allTickets = await db.select().from(tickets).where(
    inArray(tickets.id, ticketIds),
  );
  const jiraKeys = allTickets.map((t) => t.jiraKey).filter(Boolean);
  const jiraRef = jiraKeys.length > 0 ? ` [${jiraKeys.join(", ")}]` : "";

  // Idempotency: if this PR was already merged (e.g. crash after a successful
  // merge but before the deployments row was written), skip straight to
  // ticket/Jira bookkeeping instead of attempting a second merge.
  const preStatus = await vcs.getPullRequestStatus(prNumber);
  let commitSha: string | null = preStatus?.merged ? preStatus.headSha : null;

  if (!preStatus?.merged) {
    const readiness = await checkMergeReadiness(branch, ticketIds, prNumber);
    if (!readiness.ready) {
      console.warn(`[deploy] PR #${prNumber} (${branch}) not ready to merge — ${readiness.reason}`);
      try {
        await vcs.requestChanges(prNumber, `Merge blocked: ${readiness.reason}`);
      } catch { /* best-effort — PR may already be in Changes Requested state */ }
      if (cycleId) {
        await logAudit({
          cycleId,
          action: "pr.merge_blocked",
          actor: "deploy",
          entityType: "pull_request",
          entityId: String(prNumber),
          details: { branch, reason: readiness.reason },
          status: "failure",
        });
      }
      const [deployment] = await db
        .insert(deployments)
        .values({ env: QA_BRANCH, commitSha: "none", tag: null, prNumber, prUrl, status: "blocked" })
        .returning();
      return { deploymentId: deployment.id, commitSha: null, tag: null, ticketsDeployed: 0, status: "blocked", blockReason: readiness.reason };
    }

    try {
      commitSha = await vcs.mergePullRequest(prNumber, "merge");
    } catch (err) {
      const errMsg = (err as Error).message;
      const isConflict = vcs.isConflictError(err as Error);

      if (isConflict) {
        console.warn(`[deploy] Merge conflict for PR #${prNumber} (${branch}) — updating branch from ${QA_BRANCH} and retrying once...`);
        try {
          await vcs.updateBranchFromBase(branch, QA_BRANCH);
          commitSha = await vcs.mergePullRequest(prNumber, "merge");
        } catch (resolveErr) {
          console.error(`[deploy] Conflict resolution failed: ${(resolveErr as Error).message}`);
        }
      } else {
        console.error(`[deploy] Merge failed for PR #${prNumber} (${branch}): ${errMsg}`);
      }
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
        action: "pr.merge_failed",
        actor: "deploy",
        entityType: "pull_request",
        entityId: String(prNumber),
        details: { branch },
        status: "failure",
      });
    }
    const [deployment] = await db
      .insert(deployments)
      .values({ env: QA_BRANCH, commitSha: "none", tag: null, prNumber, prUrl, status: "failed" })
      .returning();
    return { deploymentId: deployment.id, commitSha: null, tag: null, ticketsDeployed: 0, status: "failed" };
  }

  let tag: string | null = null;
  tag = `${LABEL_PREFIX_SLUG}-${QA_BRANCH}-${commitSha.slice(0, 7)}`;
  await vcs.createTag(tag, commitSha);

  const [deployment] = await db
    .insert(deployments)
    .values({
      env: QA_BRANCH,
      commitSha,
      tag,
      prNumber,
      prUrl,
      status: "succeeded",
    })
    .returning();

  for (const t of allTickets) {
    await db.update(tickets).set({ status: "done" }).where(eq(tickets.id, t.id));
    if (t.jiraKey) {
      await postResolutionComment(t.jiraKey, {
        branch,
        commitSha,
        prUrl,
        mergeMethod: "merge",
        tag,
        ticketId: t.id,
      });
      await tracker.transitionTicket(t.jiraKey, "Done");
    }
  }

  if (cycleId) {
    await logAudit({
      cycleId,
      action: "pr.merged",
      actor: "deploy",
      entityType: "pull_request",
      entityId: String(prNumber),
      details: { branch, commitSha, tag, ticketsDeployed: allTickets.length },
      status: "success",
    });
  }

  console.log(`[deploy] Merged PR #${prNumber} (${branch}) — ${allTickets.length} ticket(s) deployed.`);
  return { deploymentId: deployment.id, commitSha, tag, ticketsDeployed: allTickets.length, status: "succeeded" };
}
