import "dotenv/config";
import { eq } from "drizzle-orm";
import { traceable } from "langsmith/traceable";
import { db } from "../db/client.js";
import { fixAttempts, tickets, deployments, reviewResults } from "../db/schema.js";
import { mergeBranch, createTag } from "../integrations/github.js";
import { transitionTicket } from "../integrations/jira.js";
import { LABEL_PREFIX_SLUG } from "../lib/config.js";
import { resolveConflicts } from "./conflict-resolver.js";

const QA_BRANCH = process.env.GITHUB_QA_BRANCH ?? "qa";

export interface DeployResult {
  deploymentId: string | null;
  commitSha: string | null;
  tag: string | null;
}

/**
 * Merges an approved fix into the qa integration branch and tags it for
 * rollback — per architecture doc §06: "redeploy the last-good tag" instead
 * of a git-archaeology exercise.
 */
export const runDeployAgent = traceable(_runDeployAgent, { name: "deploy-agent", run_type: "chain" });

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
    commitSha = await mergeBranch(
      attempt.branch,
      QA_BRANCH,
      `fix(${LABEL_PREFIX_SLUG}):${jiraRef} merge ${attempt.branch} into ${QA_BRANCH}`,
    );
  } catch (err) {
    const errMsg = (err as Error).message;
    const isConflict = /409|conflict|merge/i.test(errMsg);

    if (isConflict) {
      console.warn(`[deploy] Merge conflict detected for ${attempt.branch}${jiraRef} — invoking conflict resolver...`);
      try {
        const resolution = await resolveConflicts(fixAttemptId);
        if (resolution.resolved) {
          console.log(`[deploy] Conflicts resolved for ${attempt.branch} — retrying merge...`);
          commitSha = await mergeBranch(
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
        await transitionTicket(ticket.jiraKey, "To Do");
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
    await createTag(tag, commitSha);
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
    await transitionTicket(ticket.jiraKey, "Done");
  }

  return { deploymentId: deployment.id, commitSha, tag };
}
