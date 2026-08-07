import "dotenv/config";
import { inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { tickets } from "../db/schema.js";
import { openPullRequest } from "../integrations/github.js";
import { notifySlack } from "../lib/notify.js";
import { sendEmail } from "../integrations/email.js";
import { LABEL_PREFIX } from "../lib/config.js";
import type { ReleaseReport } from "../types/index.js";

const QA_BRANCH = process.env.GITHUB_QA_BRANCH ?? "qa";
const BASE_BRANCH = process.env.GITHUB_BASE_BRANCH ?? "master";

/**
 * Release agent — the single human checkpoint. Opens the qa->main PR and
 * compiles fixed/parked/flagged into one report so the reviewer sees every
 * exception in one place, per architecture doc §01/§06. Never merges.
 */
export async function runReleaseAgent(cycleId: string): Promise<ReleaseReport> {
  const doneTickets = await db.select().from(tickets).where(inArray(tickets.status, ["done"]));
  const parkedTickets = await db.select().from(tickets).where(inArray(tickets.status, ["parked"]));
  const flaggedTickets = await db.select().from(tickets).where(inArray(tickets.status, ["flagged"]));

  const reportBody = [
    `**Fixed & verified (${doneTickets.length}):**`,
    ...doneTickets.map((t) => `- ${t.jiraKey ?? t.id}: ${t.category}`),
    `\n**Parked — failed automated review twice, needs a manual fix (${parkedTickets.length}):**`,
    ...parkedTickets.map((t) => `- ${t.jiraKey ?? t.id}: ${t.category}`),
    `\n**Flagged — scope guard held this out of the merge, needs manual review (${flaggedTickets.length}):**`,
    ...flaggedTickets.map((t) => `- ${t.jiraKey ?? t.id}: ${t.category}`),
  ].join("\n");

  const pr = await openPullRequest({
    head: QA_BRANCH,
    base: BASE_BRANCH,
    title: `[${LABEL_PREFIX}] Accessibility remediation cycle ${cycleId}`,
    body: reportBody,
    draft: false,
  });

  const report: ReleaseReport = {
    cycleId,
    prUrl: pr?.url ?? null,
    fixedTicketIds: doneTickets.map((t) => t.id),
    parkedTicketIds: parkedTickets.map((t) => t.id),
    flaggedTicketIds: flaggedTickets.map((t) => t.id),
    generatedAt: new Date(),
  };

  const summaryLine =
    `Accessibility remediation cycle ${cycleId} complete: ${doneTickets.length} fixed, ` +
    `${parkedTickets.length} parked, ${flaggedTickets.length} flagged. ` +
    (report.prUrl ? `Review: ${report.prUrl}` : "PR was not opened — check GitHub configuration.");

  await notifySlack(summaryLine);
  await sendEmail(`[${LABEL_PREFIX}] Accessibility cycle ${cycleId} report`, `${summaryLine}\n\n${reportBody}`);

  return report;
}
