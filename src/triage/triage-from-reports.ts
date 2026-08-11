import path from "node:path";
import crypto from "node:crypto";
import { readReportDir, aggregateByRule } from "./report-reader.js";
import { classifyIssues } from "./issue-classifier.js";
import { buildTicketPayloads, type JiraTicketPayload } from "./ticket-builder.js";
import { ensureEpic, createTriagedTicket, findExistingJiraTicket } from "../integrations/jira.js";
import { LABEL_PREFIX } from "../lib/config.js";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { scanRuns, issues, tickets as ticketsTable } from "../db/schema.js";
import { categorize } from "./categorize.js";

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
  dbSync: {
    ticketsCreated: number;
    issuesCreated: number;
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
      dbSync: { ticketsCreated: 0, issuesCreated: 0 },
    };
  }

  console.log("[triage] Classifying issues with LLM...");
  const classified = await classifyIssues(aggregated);

  const payloads = buildTicketPayloads(classified, LABEL_PREFIX, pages);

  let epicKey: string | null = null;
  if (opts.cycleId && !opts.dryRun) {
    epicKey = await ensureEpic(opts.cycleId);
  }

  let syntheticScanRunId: string | null = null;
  if (!opts.dryRun) {
    const [syntheticRun] = await db
      .insert(scanRuns)
      .values({
        targetEnv: "report-import",
        toolVersions: { source: "triage-from-reports", reportDir },
        triggeredBy: "triage-from-reports",
      })
      .returning();
    syntheticScanRunId = syntheticRun.id;
  }

  const resultTickets: TriageFromReportsResult["tickets"] = [];
  const byIssueType: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  let dbTicketsCreated = 0;
  let dbIssuesCreated = 0;

  for (const payload of payloads) {
    byIssueType[payload.issueType] = (byIssueType[payload.issueType] ?? 0) + 1;
    byPriority[payload.priority] = (byPriority[payload.priority] ?? 0) + 1;

    let jiraKey: string | null = null;
    if (!opts.dryRun) {
      const category = categorize(payload.classified.ruleId);

      // Skip categories that were already fixed in this cycle — avoids
      // re-creating tickets for issues the scan still reports because CI/CD
      // hasn't deployed the merged code yet.
      const [recentlyDone] = await db
        .select()
        .from(ticketsTable)
        .where(and(eq(ticketsTable.category, category), eq(ticketsTable.status, "done")));
      if (recentlyDone) {
        console.log(`[triage] Skipping category "${category}" — ticket ${recentlyDone.jiraKey ?? recentlyDone.id} was already marked done`);
        continue;
      }

      const [existingForJira] = await db
        .select()
        .from(ticketsTable)
        .where(and(eq(ticketsTable.category, category), inArray(ticketsTable.status, ["open", "in_review"])));

      if (existingForJira?.jiraKey) {
        jiraKey = existingForJira.jiraKey;
        console.log(`[triage] Reusing existing Jira ticket ${jiraKey} for category "${category}" (from local DB)`);
      } else {
        // Check Jira directly for an existing open ticket before creating a new one
        const existingJiraKey = await findExistingJiraTicket({
          summaryPrefix: `[${LABEL_PREFIX}] ${category}`,
          labels: payload.labels,
        });

        if (existingJiraKey) {
          jiraKey = existingJiraKey;
          console.log(`[triage] Found existing Jira ticket ${jiraKey} for category "${category}" — skipping creation`);
        } else {
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
        }
      }

      const issueIds: string[] = [];
      for (const page of payload.classified.affectedPages) {
        for (const node of page.nodes) {
          const selector = node.target?.join(" ") ?? "unknown";
          const fingerprint = crypto
            .createHash("sha256")
            .update(`${payload.classified.ruleId}:${selector}:${page.url}`)
            .digest("hex");

          try {
            const [inserted] = await db
              .insert(issues)
              .values({
                scanRunId: syntheticScanRunId!,
                fingerprint,
                wcagRule: payload.classified.ruleId,
                selector,
                pageUrl: page.url,
                severity: payload.classified.impact,
                status: "ticketed",
              })
              .onConflictDoNothing()
              .returning();
            if (inserted) {
              issueIds.push(inserted.id);
              dbIssuesCreated++;
            } else {
              const [existing] = await db
                .select({ id: issues.id })
                .from(issues)
                .where(eq(issues.fingerprint, fingerprint))
                .limit(1);
              if (existing) {
                issueIds.push(existing.id);
                console.log(`[triage] Reusing existing issue ${existing.id} for fingerprint ${fingerprint.slice(0, 8)}`);
              }
            }
          } catch (err) {
            console.warn(`[triage] Skipped duplicate issue: ${fingerprint.slice(0, 8)}`);
          }
        }
      }

      const [existingTicket] = await db
        .select()
        .from(ticketsTable)
        .where(and(eq(ticketsTable.category, category), inArray(ticketsTable.status, ["open", "in_review"])));

      if (existingTicket) {
        const mergedIds = [...new Set([...(existingTicket.issueIds as string[]), ...issueIds])];
        await db.update(ticketsTable).set({ issueIds: mergedIds }).where(eq(ticketsTable.id, existingTicket.id));
        console.log(`[triage] Merged ${issueIds.length} issue(s) into existing ticket ${existingTicket.jiraKey ?? existingTicket.id} (category: ${category}, total: ${mergedIds.length})`);
      } else if (issueIds.length > 0 || jiraKey) {
        await db.insert(ticketsTable).values({
          jiraKey,
          epicKey,
          category,
          issueIds,
          status: "open",
        });
        dbTicketsCreated++;
        console.log(`[triage] Created ticket for "${category}" — jiraKey: ${jiraKey}, issueIds: ${issueIds.length}`);
        if (issueIds.length === 0) {
          console.warn(`[triage] ⚠ Ticket "${category}" (${jiraKey}) created with 0 issueIds — the developer agent will skip it.`);
        }
      }
    } else {
      console.log(`[triage] [dry-run] Would create: ${payload.summary}`);
      console.log(`         Type: ${payload.issueType} | Priority: ${payload.priority} | Impact: ${payload.classified.impact}`);
      console.log(`         Pages: ${payload.classified.affectedPages.length} | Elements: ${payload.classified.totalNodeCount}`);
    }

    resultTickets.push({
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
    tickets: resultTickets,
    summary: {
      totalViolationTypes: aggregated.length,
      totalElements,
      pagesScanned: pages.length,
      byIssueType,
      byPriority,
    },
    dbSync: {
      ticketsCreated: dbTicketsCreated,
      issuesCreated: dbIssuesCreated,
    },
  };
}
