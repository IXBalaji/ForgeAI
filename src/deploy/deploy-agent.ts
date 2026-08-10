import "dotenv/config";
import { eq } from "drizzle-orm";
import { traceable } from "langsmith/traceable";
import { db } from "../db/client.js";
import { fixAttempts, tickets, deployments } from "../db/schema.js";
import { mergePullRequest, createTag } from "../integrations/github.js";
import { LABEL_PREFIX_SLUG } from "../lib/config.js";

const QA_BRANCH = process.env.GITHUB_QA_BRANCH ?? "qa";

function prNumberFromUrl(prUrl: string | null): number | null {
  if (!prUrl) return null;
  const match = prUrl.match(/\/pull\/(\d+)/);
  return match ? Number(match[1]) : null;
}

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

  const prNumber = prNumberFromUrl(attempt.prUrl);
  if (!prNumber) {
    console.warn(`[deploy] FixAttempt ${fixAttemptId} has no PR — nothing to merge.`);
    return { deploymentId: null, commitSha: null, tag: null };
  }

  const commitSha = await mergePullRequest(prNumber, "squash");
  if (!commitSha) {
    console.warn(`[deploy] Merge did not return a commit sha — GitHub may not be configured.`);
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

  return { deploymentId: deployment.id, commitSha, tag };
}
