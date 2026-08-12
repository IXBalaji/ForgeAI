import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { traceable } from "langsmith/traceable";
import { db } from "../db/client.js";
import { fixAttempts, tickets, deployments, reviewResults } from "../db/schema.js";
import { getVcsProvider } from "../integrations/vcs/factory.js";
import { getTrackerProvider } from "../integrations/tracker/factory.js";
import { LABEL_PREFIX_SLUG } from "../lib/config.js";
import { resolveConflicts } from "./conflict-resolver.js";

const QA_BRANCH = process.env.GITHUB_QA_BRANCH ?? "qa";

const vcs = getVcsProvider();
const tracker = getTrackerProvider();

async function postResolutionComment(
  jiraKey: string,
  opts: { branch: string; commitSha: string | null; tag: string | null; ticketId: string },
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
 * Merge a shared branch containing fixes for multiple tickets into QA.
 * All tickets are marked "done" on success.
 */
export const deployBranch = traceable(_deployBranch, {
  name: "deploy.merge_branch",
  run_type: "chain",
  metadata: { node_kind: "orchestration" },
});

async function _deployBranch(
  branch: string,
  ticketIds: string[],
): Promise<BranchDeployResult> {
  const allTickets = await db.select().from(tickets).where(
    inArray(tickets.id, ticketIds),
  );
  const jiraKeys = allTickets.map((t) => t.jiraKey).filter(Boolean);
  const jiraRef = jiraKeys.length > 0 ? ` [${jiraKeys.join(", ")}]` : "";

  let commitSha: string | null = null;
  try {
    commitSha = await vcs.mergeBranch(
      branch,
      QA_BRANCH,
      `fix(${LABEL_PREFIX_SLUG}):${jiraRef} merge ${branch} into ${QA_BRANCH} (${ticketIds.length} ticket(s))`,
    );
  } catch (err) {
    const errMsg = (err as Error).message;
    const isConflict = vcs.isConflictError(err as Error);

    if (isConflict) {
      console.warn(`[deploy] Merge conflict for ${branch} — updating branch from ${QA_BRANCH} and retrying...`);
      try {
        await vcs.updateBranchFromBase(branch, QA_BRANCH);
        commitSha = await vcs.mergeBranch(
          branch,
          QA_BRANCH,
          `fix(${LABEL_PREFIX_SLUG}):${jiraRef} merge ${branch} into ${QA_BRANCH} (conflicts resolved)`,
        );
      } catch (resolveErr) {
        console.error(`[deploy] Conflict resolution failed: ${(resolveErr as Error).message}`);
      }
    }

    if (!commitSha) {
      console.error(`[deploy] Merge failed for ${branch}: ${errMsg}`);
      for (const t of allTickets) {
        if (t.jiraKey) await tracker.transitionTicket(t.jiraKey, "To Do");
        await db.update(tickets).set({ status: "open" }).where(eq(tickets.id, t.id));
      }
      const [deployment] = await db
        .insert(deployments)
        .values({ env: QA_BRANCH, commitSha: "none", tag: null, status: "failed" })
        .returning();
      return { deploymentId: deployment.id, commitSha: null, tag: null, ticketsDeployed: 0 };
    }
  }

  let tag: string | null = null;
  if (commitSha) {
    tag = `${LABEL_PREFIX_SLUG}-${QA_BRANCH}-${commitSha.slice(0, 7)}`;
    await vcs.createTag(tag, commitSha);
  }

  const [deployment] = await db
    .insert(deployments)
    .values({
      env: QA_BRANCH,
      commitSha: commitSha ?? "unknown",
      tag,
      status: commitSha ? "succeeded" : "failed",
    })
    .returning();

  for (const t of allTickets) {
    await db.update(tickets).set({ status: "done" }).where(eq(tickets.id, t.id));
    if (t.jiraKey) {
      await postResolutionComment(t.jiraKey, {
        branch,
        commitSha,
        tag,
        ticketId: t.id,
      });
      await tracker.transitionTicket(t.jiraKey, "Done");
    }
  }

  console.log(`[deploy] Merged ${branch} — ${allTickets.length} ticket(s) deployed.`);
  return { deploymentId: deployment.id, commitSha, tag, ticketsDeployed: allTickets.length };
}
