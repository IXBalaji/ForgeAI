import path from "node:path";
import crypto from "node:crypto";
import { readReportDir, aggregateByRule } from "./report-reader.js";
import { classifyIssues } from "./issue-classifier.js";
import { buildTicketPayloads } from "./ticket-builder.js";
import { getTrackerProvider } from "../integrations/tracker/factory.js";
import { LABEL_PREFIX } from "../lib/config.js";
import { confirmTicketFixed } from "../deploy/deploy-agent.js";

const tracker = getTrackerProvider();
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

// Must match the fingerprint formula used when issues are first inserted
// below, so a re-scan's fingerprints can be compared against a ticket's
// originally-recorded issueIds.
function computeFingerprint(ruleId: string, selector: string, pageUrl: string): string {
  return crypto.createHash("sha256").update(`${ruleId}:${selector}:${pageUrl}`).digest("hex");
}

/**
 * Per-ticket verification against the fresh scan. A single cycle's fix
 * branch can resolve several tickets (across several categories) at once, so
 * checking "does this violation category still appear anywhere" isn't
 * precise enough to know which specific ticket actually got fixed. Each
 * ticket already carries the exact issue fingerprints it was created to fix
 * (issueIds → issues.fingerprint) — comparing those against the fresh scan's
 * fingerprints tells us, per ticket, whether it's genuinely resolved.
 *
 * Tickets sit in "in_review" from the moment the developer commits a fix
 * until this check runs (deploy no longer marks them "done" at merge time —
 * see deploy-agent.ts). Only once none of a ticket's original fingerprints
 * reproduce in the live re-scan does it get marked "done"; otherwise it's
 * reopened with just the still-failing issues so the next fix round doesn't
 * re-attack work that's already proven resolved.
 */
async function verifyInReviewTickets(epicKey: string | null, freshFingerprints: Set<string>): Promise<void> {
  const inReviewTickets = await db
    .select()
    .from(ticketsTable)
    .where(
      epicKey
        ? and(eq(ticketsTable.status, "in_review"), eq(ticketsTable.epicKey, epicKey))
        : eq(ticketsTable.status, "in_review"),
    );

  for (const t of inReviewTickets) {
    const ticketIssueIds = (t.issueIds as string[] | null) ?? [];
    const ticketIssues = ticketIssueIds.length > 0
      ? await db.select().from(issues).where(inArray(issues.id, ticketIssueIds))
      : [];
    const stillFailing = ticketIssues.filter((i) => freshFingerprints.has(i.fingerprint));

    if (stillFailing.length === 0) {
      await confirmTicketFixed(t.id);
      for (const i of ticketIssues) {
        await db.update(issues).set({ status: "resolved" }).where(eq(issues.id, i.id));
      }
      console.log(`[triage] Verified fixed: ${t.jiraKey ?? t.id} (category "${t.category}") — ${ticketIssues.length} issue(s) no longer reproduce.`);
    } else {
      await db
        .update(ticketsTable)
        .set({ status: "open", issueIds: stillFailing.map((i) => i.id) })
        .where(eq(ticketsTable.id, t.id));
      if (t.jiraKey) {
        try {
          await tracker.transitionTicket(t.jiraKey, "To Do");
        } catch (err) {
          console.warn(`[triage] Failed to transition ${t.jiraKey} to To Do: ${(err as Error).message}`);
        }
      }
      console.log(`[triage] Not fixed yet: ${t.jiraKey ?? t.id} (category "${t.category}") — ${stillFailing.length}/${ticketIssues.length} issue(s) still reproduce.`);
    }
  }
}

export async function triageFromReports(opts: {
  reportDir?: string;
  cycleId?: string;
  /** Reuse an already-resolved epic (e.g. from a resumed/recovered cycle) instead of deriving one from cycleId. */
  epicKey?: string | null;
  dryRun?: boolean;
}): Promise<TriageFromReportsResult> {
  const reportDir = opts.reportDir ?? path.join(process.cwd(), "a11y-reports");

  console.log(`[triage] Reading reports from ${reportDir}`);
  const pages = readReportDir(reportDir);
  console.log(`[triage] Found ${pages.length} page reports`);

  const aggregated = aggregateByRule(pages);
  console.log(`[triage] Aggregated into ${aggregated.length} unique violation types`);

  let epicKey: string | null = opts.epicKey ?? null;
  if (!epicKey && opts.cycleId && !opts.dryRun) {
    epicKey = await tracker.ensureEpic(opts.cycleId);
  }

  // Run verification before the "no violations" early-return below — an
  // empty scan is exactly the case where every in-review ticket should be
  // confirmed fixed (zero fingerprints reproduce).
  if (!opts.dryRun) {
    const freshFingerprints = new Set<string>();
    for (const rule of aggregated) {
      for (const page of rule.affectedPages) {
        for (const node of page.nodes) {
          const selector = node.target?.join(" ") ?? "unknown";
          freshFingerprints.add(computeFingerprint(rule.ruleId, selector, page.url));
        }
      }
    }
    await verifyInReviewTickets(epicKey, freshFingerprints);
  }

  if (aggregated.length === 0) {
    console.log("[triage] No violations found — nothing to triage");
    return {
      epicKey,
      tickets: [],
      summary: { totalViolationTypes: 0, totalElements: 0, pagesScanned: pages.length, byIssueType: {}, byPriority: {} },
      dbSync: { ticketsCreated: 0, issuesCreated: 0 },
    };
  }

  console.log("[triage] Classifying issues with LLM...");
  const classified = await classifyIssues(aggregated);

  const payloads = buildTicketPayloads(classified, LABEL_PREFIX, pages);

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

      let [existingForJira] = await db
        .select()
        .from(ticketsTable)
        .where(and(eq(ticketsTable.category, category), inArray(ticketsTable.status, ["open", "in_review"])));

      if (!existingForJira) {
        const [doneTicket] = await db
          .select()
          .from(ticketsTable)
          .where(and(eq(ticketsTable.category, category), eq(ticketsTable.status, "done")));
        if (doneTicket) {
          await db.update(ticketsTable).set({ status: "open", issueIds: [], epicKey }).where(eq(ticketsTable.id, doneTicket.id));
          if (doneTicket.jiraKey) {
            await tracker.transitionTicket(doneTicket.jiraKey, "To Do");
          }
          console.log(`[triage] Reopened previously-done ticket ${doneTicket.jiraKey ?? doneTicket.id} for category "${category}" — violation resurfaced`);
          existingForJira = { ...doneTicket, status: "open", issueIds: [], epicKey };
        }
      }

      if (existingForJira?.jiraKey) {
        jiraKey = existingForJira.jiraKey;
        try {
          await tracker.updateTicket({
            key: jiraKey,
            summary: payload.summary,
            description: payload.description,
            labels: payload.labels,
            priority: payload.priority as "P1" | "P2" | "P3" | "P4" | undefined,
          });
          console.log(`[triage] Updated existing Jira ticket ${jiraKey} for category "${category}" with fresh scan data`);
        } catch (err) {
          console.warn(`[triage] Failed to update ${jiraKey}: ${(err as Error).message}`);
        }
      } else {
        const existingJiraKey = await tracker.findExisting({
          summaryPrefix: `[${LABEL_PREFIX}] ${category}`,
          labels: payload.labels,
        });

        if (existingJiraKey) {
          jiraKey = existingJiraKey;
          try {
            await tracker.updateTicket({
              key: jiraKey,
              summary: payload.summary,
              description: payload.description,
              labels: payload.labels,
              priority: payload.priority as "P1" | "P2" | "P3" | "P4" | undefined,
            });
            console.log(`[triage] Found and updated existing Jira ticket ${jiraKey} for category "${category}"`);
          } catch (err) {
            console.warn(`[triage] Failed to update ${jiraKey}: ${(err as Error).message}`);
          }
        } else {
          try {
            jiraKey = await tracker.createTicket({
              epicKey,
              summary: payload.summary,
              description: payload.description,
              labels: payload.labels,
              priority: payload.priority as "P1" | "P2" | "P3" | "P4" | undefined,
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
          const fingerprint = computeFingerprint(payload.classified.ruleId, selector, page.url);

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
        await db.update(ticketsTable).set({ issueIds: mergedIds, epicKey }).where(eq(ticketsTable.id, existingTicket.id));
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
