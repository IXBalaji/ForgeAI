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
import type { ReleaseReport } from "../types/index.js";

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

  // Most recent deployment/PR for this cycle window, if any.
  const [latestDeployment] = cycle
    ? await db
        .select()
        .from(deployments)
        .where(gte(deployments.deployedAt, cycle.startedAt))
        .orderBy(desc(deployments.deployedAt))
        .limit(1)
    : [];

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
    prUrl: latestDeployment?.prUrl ?? null,
    prNumber: latestDeployment?.prNumber ?? null,
    mergeStatus: latestDeployment?.status ?? null,
    testSummary: `${doneTickets.length} ticket(s) merged this cycle across ${latestDeployment ? 1 : 0} pull request(s).`,
    remainingBlockers,
  };

  const report: ReleaseReport = {
    cycleId,
    prUrl: latestDeployment?.prUrl ?? null,
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
    console.log(`[release] Post-process email already sent for cycle ${cycleId} — skipping.`);
    return report;
  }

  console.log(`[release] Generating final report and sending post-process email for cycle ${cycleId}...`);
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
    console.log(`[release] Post-process email sent for cycle ${cycleId}.`);

    // The report's only purpose was as the email attachment — once it's sent,
    // delete the local copy rather than accumulating report files forever.
    // Best-effort: a failed delete never fails the cycle.
    try {
      unlinkSync(filePath);
    } catch (err) {
      console.warn(`[release] Could not delete report file ${filePath} after sending:`, err instanceof Error ? err.message : err);
    }
  } catch (err) {
    console.error(`[release] Post-process email failed for cycle ${cycleId}:`, err instanceof Error ? err.message : err);
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
