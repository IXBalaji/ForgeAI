import { eq, and, inArray } from "drizzle-orm";
import { traceable } from "langsmith/traceable";
import { db } from "../db/client.js";
import { issues, tickets } from "../db/schema.js";
import { createTriagedTicket, updateJiraTicket, transitionTicket } from "../integrations/jira.js";
import { LABEL_PREFIX } from "../lib/config.js";
import { categorize } from "./categorize.js";

export interface TriageResult {
  ticketsCreated: number;
  ticketsUpdated: number;
  categories: string[];
}

export const runTriageAgent = traceable(_runTriageAgent, {
  name: "triage.classify_issues",
  run_type: "chain",
  metadata: { model: "orchestrator" },
});

const SEVERITY_ORDER = ["critical", "serious", "moderate", "minor"] as const;

function computeHighestSeverity(severityCounts: Record<string, number>): string {
  return SEVERITY_ORDER.find((s) => severityCounts[s]) ?? "moderate";
}

function buildTicketAdf(params: {
  category: string;
  categoryIssues: Array<{ id: string; wcagRule: string; selector: string; pageUrl: string; severity: string }>;
  severityCounts: Record<string, number>;
  highestSeverity: string;
}): any[] {
  const { category, categoryIssues, severityCounts, highestSeverity } = params;
  const affectedPages = [...new Set(categoryIssues.map((i) => i.pageUrl))];
  const wcagRules = [...new Set(categoryIssues.map((i) => i.wcagRule))];
  const selectors = categoryIssues.slice(0, 10).map((i) => i.selector);
  const priorityMap: Record<string, string> = { critical: "P1", serious: "P2", moderate: "P3", minor: "P4" };

  const content: any[] = [
    {
      type: "panel", attrs: { panelType: "info" },
      content: [{
        type: "paragraph",
        content: [
          { type: "text", text: "Priority: ", marks: [{ type: "strong" }] },
          { type: "text", text: priorityMap[highestSeverity] ?? "P3" },
          { type: "text", text: " | " },
          { type: "text", text: "Impact: ", marks: [{ type: "strong" }] },
          { type: "text", text: highestSeverity },
          { type: "text", text: " | " },
          { type: "text", text: "Instances: ", marks: [{ type: "strong" }] },
          { type: "text", text: String(categoryIssues.length) },
          { type: "text", text: " | " },
          { type: "text", text: "Pages: ", marks: [{ type: "strong" }] },
          { type: "text", text: String(affectedPages.length) },
        ],
      }],
    },
    {
      type: "heading", attrs: { level: 2 },
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
      type: "heading", attrs: { level: 2 },
      content: [{ type: "text", text: "Severity Breakdown" }],
    },
    {
      type: "table",
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
      type: "heading", attrs: { level: 2 },
      content: [{ type: "text", text: "WCAG Rules" }],
    },
    {
      type: "paragraph",
      content: [{ type: "text", text: wcagRules.join(", ") || "best-practice" }],
    },
    {
      type: "heading", attrs: { level: 2 },
      content: [{ type: "text", text: "Affected Pages" }],
    },
    {
      type: "bulletList",
      content: affectedPages.slice(0, 20).map((url) => ({
        type: "listItem",
        content: [{ type: "paragraph", content: [{ type: "text", text: url }] }],
      })),
    },
  ];

  if (affectedPages.length > 20) {
    content.push({
      type: "paragraph",
      content: [{ type: "text", text: `…and ${affectedPages.length - 20} more page(s).`, marks: [{ type: "em" }] }],
    });
  }

  content.push(
    {
      type: "heading", attrs: { level: 2 },
      content: [{ type: "text", text: "Affected Elements" }],
    },
    {
      type: "codeBlock", attrs: { language: "css" },
      content: [{ type: "text", text: selectors.join("\n") }],
    },
  );

  if (categoryIssues.length > 10) {
    content.push({
      type: "paragraph",
      content: [{ type: "text", text: `…and ${categoryIssues.length - 10} more selector(s).`, marks: [{ type: "em" }] }],
    });
  }

  content.push({ type: "rule" });
  content.push({
    type: "paragraph",
    content: [
      { type: "text", text: `Last updated: ${new Date().toISOString()}`, marks: [{ type: "em" }] },
    ],
  });

  return content;
}

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
    let [existing] = await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.category, category), inArray(tickets.status, ["open", "in_review"])));

    if (!existing) {
      const [doneTicket] = await db
        .select()
        .from(tickets)
        .where(and(eq(tickets.category, category), eq(tickets.status, "done")));
      if (doneTicket) {
        await db.update(tickets).set({ status: "open", issueIds: [], epicKey }).where(eq(tickets.id, doneTicket.id));
        if (doneTicket.jiraKey) {
          await transitionTicket(doneTicket.jiraKey, "To Do");
        }
        console.log(`[triage] Reopened previously-done ticket ${doneTicket.jiraKey ?? doneTicket.id} for category "${category}" — violation resurfaced`);
        existing = { ...doneTicket, status: "open", issueIds: [], epicKey };
      }
    }

    const newIssueIds = categoryIssues.map((i) => i.id);

    const severityCounts: Record<string, number> = {};
    for (const i of categoryIssues) severityCounts[i.severity] = (severityCounts[i.severity] ?? 0) + 1;
    const highestSeverity = computeHighestSeverity(severityCounts);
    const priorityMap: Record<string, string> = { critical: "P1", serious: "P2", moderate: "P3", minor: "P4" };
    const wcagRules = [...new Set(categoryIssues.map((i) => i.wcagRule))];

    const adfContent = buildTicketAdf({ category, categoryIssues, severityCounts, highestSeverity });

    if (existing) {
      const mergedIssueIds = Array.from(new Set([...(existing.issueIds as string[]), ...newIssueIds]));
      await db.update(tickets).set({ issueIds: mergedIssueIds, epicKey }).where(eq(tickets.id, existing.id));

      if (existing.jiraKey) {
        try {
          await updateJiraTicket({
            jiraKey: existing.jiraKey,
            summary: `[${LABEL_PREFIX}] ${category}`,
            description: { type: "doc", version: 1, content: adfContent },
            labels: [LABEL_PREFIX, ...wcagRules.map((r) => `a11y:${r}`)],
            priority: priorityMap[highestSeverity],
          });
          console.log(`[triage] Updated Jira ticket ${existing.jiraKey} for category "${category}" with ${mergedIssueIds.length} issue(s)`);
        } catch (err) {
          console.warn(`[triage] Failed to update Jira ticket ${existing.jiraKey}: ${(err as Error).message}`);
        }
      }
      ticketsUpdated += 1;
    } else {
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
