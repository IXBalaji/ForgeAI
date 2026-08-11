import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { searchTickets } from "../integrations/jira.js";
import { JIRA_PROJECT_KEY } from "../lib/config.js";
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
  const jql =
    opts.jql ??
    `project = "${JIRA_PROJECT_KEY}" AND labels = "accessibility" AND status != Done ORDER BY created DESC`;

  console.log(`[sync:jira] Searching Jira: ${jql}`);
  const jiraIssues = await searchTickets(jql, opts.maxResults ?? 50);
  console.log(`[sync:jira] Found ${jiraIssues.length} Jira issue(s)`);

  let synced = 0;
  let skipped = 0;
  const errors: string[] = [];

  if (jiraIssues.length === 0) {
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

  for (const jiraIssue of jiraIssues) {
    const jiraKey: string = jiraIssue.key;

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
      const parsed = parseJiraIssue(jiraIssue);
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
        epicKey: jiraIssue.fields?.parent?.key ?? null,
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

function parseJiraIssue(jiraIssue: any): ParsedJiraIssue {
  const summary: string = jiraIssue.fields?.summary ?? "";
  const description = jiraIssue.fields?.description;
  const priority: string = jiraIssue.fields?.priority?.name ?? "Medium";

  const ruleId = extractRuleIdFromSummary(summary) ?? extractRuleIdFromAdf(description) ?? "unknown";
  const impact = extractImpactFromAdf(description) ?? mapPriorityToImpact(priority);
  const pages = extractPagesFromAdf(description);

  if (pages.length === 0) {
    pages.push({ url: process.env.TARGET_FRONTEND_URL ?? "http://localhost:5173", selectors: ["unknown"] });
  }

  return { ruleId, impact, pages };
}

function extractRuleIdFromSummary(summary: string): string | null {
  const match = summary.match(/\(([a-z0-9-]+)\)\s*$/);
  return match?.[1] ?? null;
}

function extractRuleIdFromAdf(description: any): string | null {
  if (!description?.content) return null;
  const refItems = extractBulletListTexts(description.content);
  for (const item of refItems) {
    const match = item.match(/^Rule:\s*(.+)$/);
    if (match) return match[1].trim();
  }
  return null;
}

function extractImpactFromAdf(description: any): string | null {
  if (!description?.content) return null;
  for (const node of description.content) {
    if (node.type === "panel" && node.attrs?.panelType === "info") {
      const panelText = collectText(node);
      const match = panelText.match(/Impact:\s*(\w+)/);
      if (match) return match[1].toLowerCase();
    }
  }
  return null;
}

function extractPagesFromAdf(description: any): Array<{ url: string; selectors: string[] }> {
  if (!description?.content) return [];
  const pages: Array<{ url: string; selectors: string[] }> = [];
  const nodes: any[] = description.content;

  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].type === "heading" && nodes[i].attrs?.level === 3) {
      const pagePath = collectText(nodes[i]).trim();
      if (!pagePath || pagePath === "Reference" || pagePath === "Summary" || pagePath === "Scope" || pagePath === "WCAG Criteria") continue;

      const selectors: string[] = [];
      if (i + 1 < nodes.length && nodes[i + 1].type === "table") {
        const table = nodes[i + 1];
        for (let r = 1; r < (table.content?.length ?? 0); r++) {
          const row = table.content[r];
          const firstCell = row?.content?.[0];
          if (firstCell) {
            const selectorText = collectText(firstCell).trim();
            if (selectorText) selectors.push(selectorText);
          }
        }
      }

      const baseUrl = process.env.TARGET_FRONTEND_URL ?? "http://localhost:5173";
      const url = pagePath.startsWith("http") ? pagePath : `${baseUrl}${pagePath}`;
      if (selectors.length > 0) pages.push({ url, selectors });
    }
  }

  return pages;
}

function collectText(node: any): string {
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text ?? "";
  if (node.content) return node.content.map(collectText).join("");
  return "";
}

function extractBulletListTexts(nodes: any[]): string[] {
  const texts: string[] = [];
  for (const node of nodes) {
    if (node.type === "bulletList") {
      for (const item of node.content ?? []) {
        texts.push(collectText(item).trim());
      }
    }
  }
  return texts;
}

function mapPriorityToImpact(priority: string): string {
  const map: Record<string, string> = { Highest: "critical", High: "serious", Medium: "moderate", Low: "minor" };
  return map[priority] ?? "moderate";
}
