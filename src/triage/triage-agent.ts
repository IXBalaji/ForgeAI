import { eq, and, inArray } from "drizzle-orm";
import { traceable } from "langsmith/traceable";
import { db } from "../db/client.js";
import { issues, tickets } from "../db/schema.js";
import { getTrackerProvider } from "../integrations/tracker/factory.js";
import { LABEL_PREFIX } from "../lib/config.js";
import { categorize } from "./categorize.js";

const tracker = getTrackerProvider();

export interface TriageResult {
  ticketsCreated: number;
  ticketsUpdated: number;
  categories: string[];
}

export const runTriageAgent = traceable(_runTriageAgent, {
  name: "triage.classify_issues",
  run_type: "chain",
  metadata: { node_kind: "orchestration" },
});

const SEVERITY_ORDER = ["critical", "serious", "moderate", "minor"] as const;

function computeHighestSeverity(severityCounts: Record<string, number>): string {
  return SEVERITY_ORDER.find((s) => severityCounts[s]) ?? "moderate";
}

function buildTicketMarkdown(params: {
  category: string;
  categoryIssues: Array<{ id: string; wcagRule: string; selector: string; pageUrl: string; severity: string }>;
  severityCounts: Record<string, number>;
  highestSeverity: string;
}): string {
  const { category, categoryIssues, severityCounts, highestSeverity } = params;
  const affectedPages = [...new Set(categoryIssues.map((i) => i.pageUrl))];
  const wcagRules = [...new Set(categoryIssues.map((i) => i.wcagRule))];
  const selectors = categoryIssues.slice(0, 10).map((i) => i.selector);
  const priorityMap: Record<string, string> = { critical: "P1", serious: "P2", moderate: "P3", minor: "P4" };

  const lines: string[] = [
    `> Priority: **${priorityMap[highestSeverity] ?? "P3"}** | Impact: **${highestSeverity}** | Instances: **${categoryIssues.length}** | Pages: **${affectedPages.length}**`,
    "## Summary",
    `${categoryIssues.length} instance(s) of **${category}** found across ${affectedPages.length} page(s).`,
    "## Severity Breakdown",
    "| Severity | Count |",
    "| --- | --- |",
    ...Object.entries(severityCounts).map(([sev, count]) => `| ${sev} | ${count} |`),
    "## WCAG Rules",
    wcagRules.join(", ") || "best-practice",
    "## Affected Pages",
    ...affectedPages.slice(0, 20).map((url) => `- ${url}`),
  ];

  if (affectedPages.length > 20) {
    lines.push(`*…and ${affectedPages.length - 20} more page(s).*`);
  }

  lines.push("## Affected Elements");
  lines.push("```css");
  lines.push(selectors.join("\n"));
  lines.push("```");

  if (categoryIssues.length > 10) {
    lines.push(`*…and ${categoryIssues.length - 10} more selector(s).*`);
  }

  lines.push("---");
  lines.push(`*Last updated: ${new Date().toISOString()}*`);

  return lines.join("\n");
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
      .where(and(eq(tickets.category, category), inArray(tickets.status, ["open", "in_progress", "in_review"])));

    if (!existing) {
      const [doneTicket] = await db
        .select()
        .from(tickets)
        .where(and(eq(tickets.category, category), eq(tickets.status, "done")));
      if (doneTicket) {
        await db.update(tickets).set({ status: "open", issueIds: [], epicKey }).where(eq(tickets.id, doneTicket.id));
        if (doneTicket.jiraKey) {
          await tracker.transitionTicket(doneTicket.jiraKey, "To Do");
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

    const descriptionMarkdown = buildTicketMarkdown({ category, categoryIssues, severityCounts, highestSeverity });

    if (existing) {
      const mergedIssueIds = Array.from(new Set([...(existing.issueIds as string[]), ...newIssueIds]));
      await db.update(tickets).set({ issueIds: mergedIssueIds, epicKey }).where(eq(tickets.id, existing.id));

      if (existing.jiraKey) {
        try {
          await tracker.updateTicket({
            key: existing.jiraKey,
            summary: `[${LABEL_PREFIX}] ${category}`,
            description: descriptionMarkdown,
            labels: [LABEL_PREFIX, ...wcagRules.map((r) => `a11y:${r}`)],
            priority: priorityMap[highestSeverity] as "P1" | "P2" | "P3" | "P4" | undefined,
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
        jiraKey = await tracker.createTicket({
          epicKey,
          summary: `[${LABEL_PREFIX}] ${category}`,
          description: descriptionMarkdown,
          labels: [LABEL_PREFIX, ...wcagRules.map((r) => `a11y:${r}`)],
          priority: priorityMap[highestSeverity] as "P1" | "P2" | "P3" | "P4" | undefined,
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
