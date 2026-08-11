import { eq, and, inArray } from "drizzle-orm";
import { traceable } from "langsmith/traceable";
import { db } from "../db/client.js";
import { issues, tickets } from "../db/schema.js";
import { createTriagedTicket } from "../integrations/jira.js";
import { LABEL_PREFIX } from "../lib/config.js";
import { categorize } from "./categorize.js";

export interface TriageResult {
  ticketsCreated: number;
  ticketsUpdated: number;
  categories: string[];
}

/**
 * Triage agent — groups this scan's open issues by category, creates one ticket
 * per category (not one per issue instance), and merges into an existing open
 * ticket for that category if one is already in flight.
 */
export const runTriageAgent = traceable(_runTriageAgent, {
  name: "triage-agent",
  run_type: "chain",
  metadata: { model: "orchestrator" },
});

async function _runTriageAgent(scanRunId: string, epicKey: string | null): Promise<TriageResult> {
  const openIssues = await db.select().from(issues).where(
    and(eq(issues.scanRunId, scanRunId), eq(issues.status, "open")),
  );

  const byCategory = new Map<string, typeof openIssues>();
  for (const issue of openIssues) {
    const category = categorize(issue.wcagRule);
    byCategory.set(category, [...(byCategory.get(category) ?? []), issue]);
  }

  let ticketsCreated = 0;
  let ticketsUpdated = 0;

  for (const [category, categoryIssues] of byCategory) {
    const [existing] = await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.category, category), inArray(tickets.status, ["open", "in_review"])));

    const newIssueIds = categoryIssues.map((i) => i.id);

    if (existing) {
      const mergedIssueIds = Array.from(new Set([...(existing.issueIds as string[]), ...newIssueIds]));
      await db.update(tickets).set({ issueIds: mergedIssueIds }).where(eq(tickets.id, existing.id));
      ticketsUpdated += 1;
    } else {
      const severityCounts: Record<string, number> = {};
      for (const i of categoryIssues) severityCounts[i.severity] = (severityCounts[i.severity] ?? 0) + 1;

      const highestSeverity = (["critical", "serious", "moderate", "minor"] as const)
        .find((s) => severityCounts[s]) ?? "moderate";
      const priorityMap: Record<string, string> = { critical: "P1", serious: "P2", moderate: "P3", minor: "P4" };

      const affectedPages = [...new Set(categoryIssues.map((i) => i.pageUrl))];
      const selectors = categoryIssues.slice(0, 10).map((i) => i.selector);

      const adfContent: any[] = [
        {
          type: "heading", attrs: { level: 3 },
          content: [{ type: "text", text: "Summary" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: `${categoryIssues.length} instance(s) of ` },
            { type: "text", text: category, marks: [{ type: "strong" }] },
            { type: "text", text: ` found across ${affectedPages.length} page(s).` },
          ],
        },
        {
          type: "heading", attrs: { level: 3 },
          content: [{ type: "text", text: "Severity Breakdown" }],
        },
        {
          type: "table", attrs: { layout: "default" },
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Severity" }] }] },
                { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Count" }] }] },
              ],
            },
            ...Object.entries(severityCounts).map(([sev, count]) => ({
              type: "tableRow",
              content: [
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: sev }] }] },
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: String(count) }] }] },
              ],
            })),
          ],
        },
        {
          type: "heading", attrs: { level: 3 },
          content: [{ type: "text", text: "Affected Pages" }],
        },
        {
          type: "bulletList",
          content: affectedPages.slice(0, 20).map((url) => ({
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: url }] }],
          })),
        },
        {
          type: "heading", attrs: { level: 3 },
          content: [{ type: "text", text: "Example Selectors" }],
        },
        {
          type: "codeBlock", attrs: { language: "css" },
          content: [{ type: "text", text: selectors.join("\n") }],
        },
      ];

      if (categoryIssues.length > 10) {
        adfContent.push({
          type: "paragraph",
          content: [{ type: "text", text: `…and ${categoryIssues.length - 10} more selector(s).`, marks: [{ type: "em" }] }],
        });
      }

      const wcagRules = [...new Set(categoryIssues.map((i) => i.wcagRule))];

      let jiraKey: string | null = null;
      try {
        jiraKey = await createTriagedTicket({
          epicKey,
          summary: `[${LABEL_PREFIX}] ${category}`,
          description: { type: "doc", version: 1, content: adfContent },
          labels: [LABEL_PREFIX, ...wcagRules.map((r) => `a11y:${r}`)],
          priority: priorityMap[highestSeverity],
        });
      } catch (err) {
        console.warn(`[triage] Failed to create Jira ticket for "${category}" — continuing locally:`, (err as Error).message);
      }

      await db.insert(tickets).values({
        jiraKey,
        epicKey,
        category,
        issueIds: newIssueIds,
        status: "open",
      });
      ticketsCreated += 1;
    }

    await db
      .update(issues)
      .set({ status: "ticketed" })
      .where(inArray(issues.id, newIssueIds));
  }

  return { ticketsCreated, ticketsUpdated, categories: [...byCategory.keys()] };
}
