import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { and, eq, gte, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  iterationCycles,
  tickets,
  fixAttempts,
  reviewResults,
  deployments,
  auditLog,
  reportsGenerated,
} from "../db/schema.js";
import { LABEL_PREFIX } from "../lib/config.js";
import { renderFinalReportHtml, type FinalReportData } from "../integrations/report-template.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const REPORTS_DIR = path.join(PROJECT_ROOT, "reports");

function timestampForFilename(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export interface FinalReportResult {
  filePath: string;
  reportId: string;
}

/**
 * Generates the timestamped final cycle report and writes it to the
 * `reports/` directory (deleted again once the post-process email has sent —
 * see release-agent.ts). Idempotent: if a report was already generated for
 * this cycle, the existing file path is returned rather than regenerating
 * (guarded by the unique (cycleId, type) row in reportsGenerated).
 */
export async function generateFinalReport(cycleId: string): Promise<FinalReportResult> {
  const [existing] = await db
    .select()
    .from(reportsGenerated)
    .where(and(eq(reportsGenerated.cycleId, cycleId), eq(reportsGenerated.type, "final_report")));
  if (existing?.filePath) {
    console.log(`[final-report] Report already generated for cycle ${cycleId} — reusing ${existing.filePath}.`);
    return { filePath: existing.filePath, reportId: existing.id };
  }

  const [cycle] = await db.select().from(iterationCycles).where(eq(iterationCycles.id, cycleId));
  if (!cycle) throw new Error(`No iteration_cycles row found for ${cycleId}`);

  const epicFilter = cycle.epicKey ? eq(tickets.epicKey, cycle.epicKey) : undefined;
  const cycleTickets = await db
    .select()
    .from(tickets)
    .where(epicFilter ? and(gte(tickets.createdAt, cycle.startedAt), epicFilter) : gte(tickets.createdAt, cycle.startedAt));
  const ticketIds = cycleTickets.map((t) => t.id);

  const attempts = ticketIds.length > 0
    ? await db.select().from(fixAttempts).where(inArray(fixAttempts.ticketId, ticketIds))
    : [];
  const attemptIds = attempts.map((a) => a.id);

  const reviews = attemptIds.length > 0
    ? await db.select().from(reviewResults).where(inArray(reviewResults.fixAttemptId, attemptIds))
    : [];

  const deploys = await db.select().from(deployments).where(gte(deployments.deployedAt, cycle.startedAt));
  const audit = await db.select().from(auditLog).where(eq(auditLog.cycleId, cycleId));

  const data: FinalReportData = {
    projectLabel: LABEL_PREFIX,
    cycleId,
    generatedAt: new Date(),
    epicKey: cycle.epicKey,
    tickets: cycleTickets.map((t) => ({ jiraKey: t.jiraKey, id: t.id, category: t.category, status: t.status })),
    fixAttempts: attempts.map((a) => ({
      ticketId: a.ticketId,
      branch: a.branch,
      commitSha: a.commitSha,
      prUrl: a.prUrl,
      prNumber: a.prNumber,
      attemptNumber: a.attemptNumber,
    })),
    reviewResults: reviews.map((r) => ({
      fixAttemptId: r.fixAttemptId,
      verdict: r.verdict,
      blockingFindingsCount: r.blockingFindingsCount,
      comments: r.comments,
    })),
    deployments: deploys.map((d) => ({
      commitSha: d.commitSha,
      tag: d.tag,
      prNumber: d.prNumber,
      prUrl: d.prUrl,
      status: d.status,
      deployedAt: d.deployedAt,
    })),
    auditLog: audit.map((a) => ({
      timestamp: a.timestamp,
      action: a.action,
      actor: a.actor,
      status: a.status,
    })),
  };

  const html = renderFinalReportHtml(data);
  const filename = `forgeai-report-${cycleId}-${timestampForFilename(data.generatedAt)}.html`;
  const filePath = path.join(REPORTS_DIR, filename);

  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(filePath, html, "utf-8");

  const [row] = await db
    .insert(reportsGenerated)
    .values({ cycleId, type: "final_report", filePath })
    .onConflictDoNothing({ target: [reportsGenerated.cycleId, reportsGenerated.type] })
    .returning();

  console.log(`[final-report] Wrote final report for cycle ${cycleId} to ${filePath}.`);
  return { filePath, reportId: row?.id ?? existing?.id ?? "" };
}
