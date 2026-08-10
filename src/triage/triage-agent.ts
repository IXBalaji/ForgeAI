import { eq, and, inArray } from "drizzle-orm";
import { traceable } from "langsmith/traceable";
import { db } from "../db/client.js";
import { issues, tickets } from "../db/schema.js";
import { createTicketStory } from "../integrations/jira.js";
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
export const runTriageAgent = traceable(_runTriageAgent, { name: "triage-agent", run_type: "chain" });

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

      const jiraKey = await createTicketStory({
        epicKey,
        category,
        severityCounts,
        issueCount: categoryIssues.length,
      });

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
