import path from "node:path";
import { readReportDir, aggregateByRule } from "./report-reader.js";
import { classifyIssues } from "./issue-classifier.js";
import { buildTicketPayloads, type JiraTicketPayload } from "./ticket-builder.js";
import { ensureEpic, createTriagedTicket } from "../integrations/jira.js";
import { LABEL_PREFIX } from "../lib/config.js";

export interface TriageFromReportsResult {
  epicKey: string | null;
  tickets: Array<{
    jiraKey: string | null;
    summary: string;
    ruleId: string;
    issueType: string;
    priority: string;
    impact: string;
    affectedPages: number;
    affectedElements: number;
  }>;
  summary: {
    totalViolationTypes: number;
    totalElements: number;
    pagesScanned: number;
    byIssueType: Record<string, number>;
    byPriority: Record<string, number>;
  };
}

export async function triageFromReports(opts: {
  reportDir?: string;
  cycleId?: string;
  dryRun?: boolean;
}): Promise<TriageFromReportsResult> {
  const reportDir = opts.reportDir ?? path.join(process.cwd(), "a11y-reports");

  console.log(`[triage] Reading reports from ${reportDir}`);
  const pages = readReportDir(reportDir);
  console.log(`[triage] Found ${pages.length} page reports`);

  const aggregated = aggregateByRule(pages);
  console.log(`[triage] Aggregated into ${aggregated.length} unique violation types`);

  if (aggregated.length === 0) {
    console.log("[triage] No violations found — nothing to triage");
    return {
      epicKey: null,
      tickets: [],
      summary: { totalViolationTypes: 0, totalElements: 0, pagesScanned: pages.length, byIssueType: {}, byPriority: {} },
    };
  }

  console.log("[triage] Classifying issues with LLM...");
  const classified = await classifyIssues(aggregated);

  const payloads = buildTicketPayloads(classified, LABEL_PREFIX, pages);

  let epicKey: string | null = null;
  if (opts.cycleId && !opts.dryRun) {
    epicKey = await ensureEpic(opts.cycleId);
  }

  const tickets: TriageFromReportsResult["tickets"] = [];
  const byIssueType: Record<string, number> = {};
  const byPriority: Record<string, number> = {};

  for (const payload of payloads) {
    byIssueType[payload.issueType] = (byIssueType[payload.issueType] ?? 0) + 1;
    byPriority[payload.priority] = (byPriority[payload.priority] ?? 0) + 1;

    let jiraKey: string | null = null;
    if (!opts.dryRun) {
      try {
        jiraKey = await createTriagedTicket({
          epicKey,
          summary: payload.summary,
          description: payload.description,
          labels: payload.labels,
          priority: payload.priority,
        });
        if (jiraKey) {
          console.log(`[triage] Created ${jiraKey}: ${payload.summary}`);
        }
      } catch (err) {
        console.error(`[triage] Failed to create Jira ticket: ${(err as Error).message}`);
      }
    } else {
      console.log(`[triage] [dry-run] Would create: ${payload.summary}`);
      console.log(`         Type: ${payload.issueType} | Priority: ${payload.priority} | Impact: ${payload.classified.impact}`);
      console.log(`         Pages: ${payload.classified.affectedPages.length} | Elements: ${payload.classified.totalNodeCount}`);
    }

    tickets.push({
      jiraKey,
      summary: payload.summary,
      ruleId: payload.classified.ruleId,
      issueType: payload.issueType,
      priority: payload.priority,
      impact: payload.classified.impact,
      affectedPages: payload.classified.affectedPages.length,
      affectedElements: payload.classified.totalNodeCount,
    });
  }

  const totalElements = aggregated.reduce((sum, a) => sum + a.totalNodeCount, 0);

  return {
    epicKey,
    tickets,
    summary: {
      totalViolationTypes: aggregated.length,
      totalElements,
      pagesScanned: pages.length,
      byIssueType,
      byPriority,
    },
  };
}
