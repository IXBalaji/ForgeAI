import "dotenv/config";
import { inArray, and, eq } from "drizzle-orm";
import { traceable } from "langsmith/traceable";
import { db } from "../db/client.js";
import { tickets, iterationCycles } from "../db/schema.js";
import { notifySlack } from "../lib/notify.js";
import { sendEmail } from "../integrations/email.js";
import { renderReleaseReportHtml, renderReleaseReportText } from "../integrations/report-template.js";
import { LABEL_PREFIX } from "../lib/config.js";
import type { ReleaseReport } from "../types/index.js";

/**
 * Release agent — compiles fixed/parked/flagged into one report and
 * notifies via Slack + email, per architecture doc §01/§06.
 */
export const runReleaseAgent = traceable(_runReleaseAgent, { name: "release.run", run_type: "chain" });

async function _runReleaseAgent(cycleId: string): Promise<ReleaseReport> {
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

  const reportData = {
    projectLabel: LABEL_PREFIX,
    cycleId,
    generatedAt: new Date(),
    fixed: doneTickets.map((t) => ({ jiraKey: t.jiraKey, id: t.id, category: t.category })),
    parked: parkedTickets.map((t) => ({ jiraKey: t.jiraKey, id: t.id, category: t.category })),
    flagged: flaggedTickets.map((t) => ({ jiraKey: t.jiraKey, id: t.id, category: t.category })),
  };

  const report: ReleaseReport = {
    cycleId,
    prUrl: null,
    fixedTicketIds: doneTickets.map((t) => t.id),
    parkedTicketIds: parkedTickets.map((t) => t.id),
    flaggedTicketIds: flaggedTickets.map((t) => t.id),
    generatedAt: new Date(),
  };

  const summaryLine =
    `Accessibility remediation cycle ${cycleId} complete: ${doneTickets.length} fixed, ` +
    `${parkedTickets.length} parked, ${flaggedTickets.length} flagged.`;

  await notifySlack(summaryLine);
  await sendEmail(
    `[${LABEL_PREFIX}] Accessibility cycle ${cycleId} report`,
    renderReleaseReportText(reportData),
    renderReleaseReportHtml(reportData),
  );

  return report;
}
