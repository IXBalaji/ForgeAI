import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { getTrackerProvider } from "../integrations/tracker/factory.js";
import type { TrackerIssue } from "../integrations/tracker/types.js";
import { runAgentTrace } from "../observability/agent-tracing.js";
import { db } from "../db/client.js";
import { scanRuns, issues, tickets } from "../db/schema.js";
import { categorize } from "./categorize.js";

export interface JiraSyncResult {
  synced: number;
  skipped: number;
  errors: string[];
}

export async function syncJiraTickets(opts: {
  jql?: string;
  maxResults?: number;
}): Promise<JiraSyncResult> {
  return runAgentTrace("jira_sync", () => _syncJiraTickets(opts));
}

async function _syncJiraTickets(opts: {
  jql?: string;
  maxResults?: number;
}): Promise<JiraSyncResult> {
  const tracker = getTrackerProvider();
  console.log(`[sync:jira] Searching tracker for labels=["accessibility"], excludeStatus=["Done"]`);
  const trackerIssues = await tracker.search({ labels: ["accessibility"], excludeStatus: ["Done"] }, opts.maxResults ?? 50);
  console.log(`[sync:jira] Found ${trackerIssues.length} tracker issue(s)`);

  let synced = 0;
  let skipped = 0;
  const errors: string[] = [];

  if (trackerIssues.length === 0) {
    return { synced, skipped, errors };
  }

  const [syntheticRun] = await db
    .insert(scanRuns)
    .values({
      targetEnv: "jira-sync",
      toolVersions: { source: "jira-scanner" },
      triggeredBy: "sync:jira",
    })
    .returning();

  for (const trackerIssue of trackerIssues) {
    const jiraKey: string = trackerIssue.key;

    const existing = await db
      .select({ id: tickets.id })
      .from(tickets)
      .where(eq(tickets.jiraKey, jiraKey))
      .limit(1);

    if (existing.length > 0) {
      skipped++;
      continue;
    }

    try {
      const parsed = parseTrackerIssue(trackerIssue);
      console.log(`[sync:jira] Parsed ${jiraKey}: ruleId="${parsed.ruleId}", impact="${parsed.impact}", pages=${parsed.pages.length}`);
      for (const page of parsed.pages) {
        console.log(`[sync:jira]   page: ${page.url} — ${page.selectors.length} selector(s)`);
      }
      const issueIds: string[] = [];

      for (const page of parsed.pages) {
        for (const selector of page.selectors) {
          const fingerprint = crypto
            .createHash("sha256")
            .update(`${parsed.ruleId}:${selector}:${page.url}`)
            .digest("hex");

          const [inserted] = await db
            .insert(issues)
            .values({
              scanRunId: syntheticRun.id,
              fingerprint,
              wcagRule: parsed.ruleId,
              selector,
              pageUrl: page.url,
              severity: parsed.impact,
              status: "ticketed",
            })
            .onConflictDoNothing()
            .returning();

          if (inserted) {
            issueIds.push(inserted.id);
          } else {
            const [existing] = await db
              .select({ id: issues.id })
              .from(issues)
              .where(eq(issues.fingerprint, fingerprint))
              .limit(1);
            if (existing) {
              issueIds.push(existing.id);
              console.log(`[sync:jira]   reusing existing issue ${existing.id} (fingerprint: ${fingerprint.slice(0, 8)})`);
            }
          }
        }
      }

      await db.insert(tickets).values({
        jiraKey,
        epicKey: trackerIssue.parentKey ?? null,
        category: categorize(parsed.ruleId),
        issueIds,
        status: "open",
      });

      synced++;
      console.log(`[sync:jira] Synced ${jiraKey}: ${parsed.ruleId} (${issueIds.length} issue(s))`);
    } catch (err) {
      const msg = `Failed to sync ${jiraKey}: ${(err as Error).message}`;
      console.error(`[sync:jira] ${msg}`);
      errors.push(msg);
    }
  }

  return { synced, skipped, errors };
}

interface ParsedJiraIssue {
  ruleId: string;
  impact: string;
  pages: Array<{ url: string; selectors: string[] }>;
}

function parseTrackerIssue(trackerIssue: TrackerIssue): ParsedJiraIssue {
  const md = trackerIssue.descriptionMarkdown;
  const priority = trackerIssue.priority ?? "Medium";

  const ruleId = extractRuleIdFromSummary(trackerIssue.summary) ?? extractRuleIdFromMarkdown(md) ?? "unknown";
  const impact = extractImpactFromMarkdown(md) ?? mapPriorityToImpact(priority);
  const pages = extractPagesFromMarkdown(md);

  if (pages.length === 0) {
    pages.push({ url: process.env.TARGET_FRONTEND_URL ?? "http://localhost:5173", selectors: ["unknown"] });
  }

  return { ruleId, impact, pages };
}

function extractRuleIdFromSummary(summary: string): string | null {
  const match = summary.match(/\(([a-z0-9-]+)\)\s*$/);
  return match?.[1] ?? null;
}

function extractRuleIdFromMarkdown(md: string): string | null {
  const match = md.match(/^-\s*Rule:\s*(.+)$/m);
  return match?.[1].trim() ?? null;
}

function extractImpactFromMarkdown(md: string): string | null {
  const match = md.match(/Impact:\s*\*\*(\w+)\*\*/);
  return match ? match[1].toLowerCase() : null;
}

function extractPagesFromMarkdown(md: string): Array<{ url: string; selectors: string[] }> {
  const pages: Array<{ url: string; selectors: string[] }> = [];
  const lines = md.split("\n");
  const baseUrl = process.env.TARGET_FRONTEND_URL ?? "http://localhost:5173";

  for (let i = 0; i < lines.length; i++) {
    const headingMatch = lines[i].match(/^###\s+(.*)$/);
    if (!headingMatch) continue;

    const pagePath = headingMatch[1].trim();
    if (!pagePath || ["Reference", "Summary", "Scope", "WCAG Criteria"].includes(pagePath)) continue;

    const selectors: string[] = [];
    // Header row + separator row (2 lines) precede the first data row.
    let j = i + 1;
    if (j < lines.length && lines[j].startsWith("|")) j += 2;
    while (j < lines.length && lines[j].startsWith("|")) {
      const firstCell = lines[j].split("|")[1]?.trim();
      if (firstCell) selectors.push(firstCell);
      j++;
    }

    const url = pagePath.startsWith("http") ? pagePath : `${baseUrl}${pagePath}`;
    if (selectors.length > 0) pages.push({ url, selectors });
  }

  return pages;
}

function mapPriorityToImpact(priority: string): string {
  const map: Record<string, string> = { Highest: "critical", High: "serious", Medium: "moderate", Low: "minor" };
  return map[priority] ?? "moderate";
}
