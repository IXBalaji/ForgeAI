import "dotenv/config";
import { unlinkSync } from "node:fs";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { tickets, iterationCycles, fixAttempts, reviewResults, deployments, reportsGenerated } from "../db/schema.js";
import { notifySlack } from "../lib/notify.js";
import { logAudit } from "../lib/audit-log.js";
import { sendEmail } from "../integrations/email.js";
import {
  renderPostProcessEmailHtml,
  renderPostProcessEmailText,
  type PostProcessEmailData,
} from "../integrations/report-template.js";
import { generateFinalReport } from "./final-report.js";
import { LABEL_PREFIX } from "../lib/config.js";
import { getVcsProvider } from "../integrations/vcs/factory.js";
import { logger } from "../lib/logger.js";
import type { ReleaseReport } from "../types/index.js";

const QA_BRANCH = process.env.GITHUB_QA_BRANCH ?? "qa";
const MAIN_BRANCH = process.env.GITHUB_BASE_BRANCH ?? "main";

const vcs = getVcsProvider();

export class ReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseError";
  }
}

export async function createReleasePr(
  vcs: ReturnType<typeof getVcsProvider>,
  head: string,
  base: string,
  title: string,
  body: string,
): Promise<{ number: number; htmlUrl: string } | null> {
  try {
    return await vcs.createPullRequest(head, base, title, body);
  } catch (err) {
    throw new ReleaseError(
      `Pull request could not be created: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Release agent — compiles fixed/parked/flagged into the post-process report
 * (with the timestamped final report attached), generates the final report
 * file, and notifies via Slack + email. Both the report and the email are
 * idempotent per cycle (guarded by the reportsGenerated unique key), so a
 * retried/resumed cycle never regenerates or re-sends either. No model
 * calls, so this isn't wrapped in its own LangSmith span — it already runs
 * inside the "agent.release" span the orchestrator creates in graph.ts.
 */
export async function runReleaseAgent(cycleId: string): Promise<ReleaseReport> {
  const [cycle] = await db.select().from(iterationCycles).where(eq(iterationCycles.id, cycleId));
  const epicKey = cycle?.epicKey ?? null;

  const epicFilter = epicKey ? eq(tickets.epicKey, epicKey) : undefined;

  const doneTickets = await db.select().from(tickets).where(
    epicFilter ? and(eq(tickets.status, "done"), epicFilter) : eq(tickets.status, "done"),
  );
  const parkedTickets = await db.select().from(tickets).where(
    epicFilter ? and(eq(tickets.status, "parked"), epicFilter) : eq(tickets.status, "parked"),
  );
  const flaggedTickets = await db.select().from(tickets).where(
    epicFilter ? and(eq(tickets.status, "flagged"), epicFilter) : eq(tickets.status, "flagged"),
  );
  const openTickets = await db.select().from(tickets).where(
    epicFilter ? and(eq(tickets.status, "open"), epicFilter) : eq(tickets.status, "open"),
  );

  const summaryLine =
    `Accessibility remediation cycle ${cycleId} complete: ${doneTickets.length} fixed, ` +
    `${parkedTickets.length} parked, ${flaggedTickets.length} flagged.`;

  await notifySlack(summaryLine);

  // Most recent deployment for this cycle window, if any (no PR — qa merges
  // are direct git merges now; see deploy-agent.ts).
  const [latestDeployment] = cycle
    ? await db
        .select()
        .from(deployments)
        .where(gte(deployments.deployedAt, cycle.startedAt))
        .orderBy(desc(deployments.deployedAt))
        .limit(1)
    : [];

  // Open (idempotent) a PR promoting the verified fixes from qa into main —
  // this is the one remaining human gate: nothing merges to production
  // without someone reviewing and merging this PR themselves.
  let releasePr: { number: number; htmlUrl: string } | null = null;
  if (doneTickets.length > 0) {
    const jiraKeys = doneTickets.map((t) => t.jiraKey).filter((k): k is string => Boolean(k));
    releasePr = await vcs.findOpenPullRequest(QA_BRANCH, MAIN_BRANCH);
    if (!releasePr) {
      const title = `[${LABEL_PREFIX}] Release: ${doneTickets.length} accessibility fix(es) — cycle ${cycleId}`;
      const bodyLines = [
        `Automated accessibility remediation ready for release — ${doneTickets.length} ticket(s) verified fixed on \`${QA_BRANCH}\`.`,
        "",
        ...jiraKeys.map((k) => `- ${k}`),
      ];
      releasePr = await createReleasePr(vcs, QA_BRANCH, MAIN_BRANCH, title, bodyLines.join("\n"));
      logger.info("release", `Created release PR ${releasePr?.htmlUrl ?? "(vcs not configured)"} (${QA_BRANCH} → ${MAIN_BRANCH}).`);
    } else {
      logger.info("release", `Reusing existing open release PR #${releasePr.number} (${QA_BRANCH} → ${MAIN_BRANCH}).`);
    }
    if (releasePr) {
      await logAudit({
        cycleId,
        action: "release.pr_created",
        actor: "orchestrator",
        entityType: "pull_request",
        entityId: String(releasePr.number),
        details: { ticketCount: doneTickets.length },
        status: "success",
      });
    }
  }

  // Latest review's blocking findings for parked/flagged tickets (remaining blockers).
  const blockerTickets = [...parkedTickets, ...flaggedTickets];
  const remainingBlockers: PostProcessEmailData["remainingBlockers"] = [];
  for (const t of blockerTickets) {
    const attempts = await db.select().from(fixAttempts).where(eq(fixAttempts.ticketId, t.id));
    const attemptIds = attempts.map((a) => a.id);
    const [latestReview] = attemptIds.length > 0
      ? await db.select().from(reviewResults).where(inArray(reviewResults.fixAttemptId, attemptIds)).orderBy(desc(reviewResults.createdAt)).limit(1)
      : [];
    remainingBlockers.push({
      jiraKey: t.jiraKey,
      id: t.id,
      category: t.category,
      reason: latestReview?.comments?.slice(0, 300) ?? `Ticket status: ${t.status}`,
    });
  }

  const emailData: PostProcessEmailData = {
    projectLabel: LABEL_PREFIX,
    cycleId,
    generatedAt: new Date(),
    resolvedCount: doneTickets.length,
    unresolvedCount: parkedTickets.length + flaggedTickets.length + openTickets.length,
    tickets: [...doneTickets, ...parkedTickets, ...flaggedTickets, ...openTickets].map((t) => ({
      jiraKey: t.jiraKey,
      id: t.id,
      category: t.category,
      status: t.status,
    })),
    prUrl: releasePr?.htmlUrl ?? null,
    prNumber: releasePr?.number ?? null,
    mergeStatus: releasePr ? "open — awaiting review" : null,
    testSummary: `${doneTickets.length} ticket(s) merged to ${QA_BRANCH} this cycle${latestDeployment ? ` (last deploy: ${latestDeployment.status})` : ""}.`,
    remainingBlockers,
  };

  const report: ReleaseReport = {
    cycleId,
    prUrl: releasePr?.htmlUrl ?? null,
    fixedTicketIds: doneTickets.map((t) => t.id),
    parkedTicketIds: parkedTickets.map((t) => t.id),
    flaggedTicketIds: flaggedTickets.map((t) => t.id),
    generatedAt: new Date(),
  };

  // Idempotency: skip regeneration/resend if already done for this cycle.
  const [alreadySent] = await db
    .select()
    .from(reportsGenerated)
    .where(and(eq(reportsGenerated.cycleId, cycleId), eq(reportsGenerated.type, "post_process_email")));

  if (alreadySent) {
    logger.info("release", `Post-process email already sent for cycle ${cycleId} — skipping.`);
    return report;
  }

  logger.info("release", `Generating final report and sending post-process email for cycle ${cycleId}...`);
  try {
    const { filePath } = await generateFinalReport(cycleId);
    await sendEmail(
      `[${LABEL_PREFIX}] Accessibility cycle ${cycleId} — post-process report`,
      renderPostProcessEmailText(emailData),
      renderPostProcessEmailHtml(emailData),
      [{ filename: filePath.split(/[\\/]/).pop() ?? "final-report.html", path: filePath }],
    );

    await db
      .insert(reportsGenerated)
      .values({ cycleId, type: "post_process_email", filePath: null })
      .onConflictDoNothing({ target: [reportsGenerated.cycleId, reportsGenerated.type] });

    await logAudit({
      cycleId,
      action: "email.post_process_sent",
      actor: "orchestrator",
      details: { resolvedCount: doneTickets.length, unresolvedCount: emailData.unresolvedCount },
      status: "success",
    });
    logger.info("release", `Post-process email sent for cycle ${cycleId}.`);

    // The report's only purpose was as the email attachment — once it's sent,
    // delete the local copy rather than accumulating report files forever.
    // Best-effort: a failed delete never fails the cycle.
    try {
      unlinkSync(filePath);
    } catch (err) {
      logger.warn("release", `Could not delete report file ${filePath} after sending:`, err instanceof Error ? err.message : err);
    }
  } catch (err) {
    logger.error("release", `Post-process email failed for cycle ${cycleId}:`, err instanceof Error ? err.message : err);
    await logAudit({
      cycleId,
      action: "email.post_process_failed",
      actor: "orchestrator",
      details: { error: err instanceof Error ? err.message.slice(0, 300) : String(err) },
      status: "failure",
    });
  }

  return report;
}
