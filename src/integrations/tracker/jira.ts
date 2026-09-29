import "dotenv/config";
import { eq } from "drizzle-orm";
import type { TrackerProvider, TrackerIssue } from "./types.js";
import { markdownToAdf } from "./markdown-to-adf.js";
import { JiraAuthError, JiraApiError } from "./errors.js";
import { logger } from "../../lib/logger.js";
import { adfToMarkdown } from "./adf-to-markdown.js";
import { LABEL_PREFIX, JIRA_PROJECT_KEY, JIRA_BASE_URL } from "../../lib/config.js";
import { db } from "../../db/client.js";
import { iterationCycles } from "../../db/schema.js";

const JIRA_SUMMARY_MAX = 255;

const PRIORITY_MAP: Record<string, string> = { P1: "Highest", P2: "High", P3: "Medium", P4: "Low" };

export class JiraAdapter implements TrackerProvider {
  readonly name = "jira";

  private readonly baseUrl: string | undefined;
  private readonly email: string | undefined;
  private readonly apiToken: string | undefined;

  constructor() {
    this.baseUrl = JIRA_BASE_URL;
    this.email = process.env.JIRA_EMAIL;
    this.apiToken = process.env.JIRA_API_TOKEN;
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl && this.email && this.apiToken);
  }

  private truncateSummary(summary: string): string {
    if (summary.length <= JIRA_SUMMARY_MAX) return summary;
    return summary.slice(0, JIRA_SUMMARY_MAX - 1) + "…";
  }

  private authHeader(): string {
    const token = Buffer.from(`${this.email}:${this.apiToken}`).toString("base64");
    return `Basic ${token}`;
  }

  private async jiraFetch(path: string, init: RequestInit): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new JiraAuthError(res.status, path);
      }
      throw new JiraApiError(res.status, init.method ?? "GET", path, await res.text());
    }
    if (res.status === 204) return null;
    return res.json();
  }

  /**
   * Reuses the epic on every subsequent call within a remediation cycle — a
   * cycle can trigger many triage passes as the loop re-scans, and they must
   * all file under the same epic. Reuse is keyed on the IterationCycle row,
   * not a timestamp label, so it's correct however many times triage runs.
   */
  async ensureEpic(cycleId: string): Promise<string | null> {
    const [cycle] = await db.select().from(iterationCycles).where(eq(iterationCycles.id, cycleId));
    if (cycle?.epicKey) return cycle.epicKey;

    if (!this.isConfigured()) {
      logger.warn("jira", "Jira not configured — skipping epic creation.");
      return null;
    }

    const created = await this.jiraFetch("/rest/api/3/issue", {
      method: "POST",
      body: JSON.stringify({
        fields: {
          project: { key: JIRA_PROJECT_KEY },
          summary: this.truncateSummary(`[${LABEL_PREFIX}] Accessibility remediation cycle ${cycleId}`),
          issuetype: { name: "Epic" },
        },
      }),
    });

    if (cycle) {
      await db.update(iterationCycles).set({ epicKey: created.key }).where(eq(iterationCycles.id, cycleId));
    }
    return created.key;
  }

  async createTicket(params: {
    epicKey: string | null;
    summary: string;
    description: string;
    labels: string[];
    priority?: "P1" | "P2" | "P3" | "P4";
  }): Promise<string | null> {
    if (!this.isConfigured()) {
      logger.warn("jira", `Jira not configured — ticket "${params.summary}" logged locally only.`);
      return null;
    }

    const fields: Record<string, any> = {
      project: { key: JIRA_PROJECT_KEY },
      summary: this.truncateSummary(params.summary),
      description: markdownToAdf(params.description),
      issuetype: { name: "Task" },
      labels: params.labels,
    };

    if (params.epicKey) fields.parent = { key: params.epicKey };
    if (params.priority && PRIORITY_MAP[params.priority]) {
      fields.priority = { name: PRIORITY_MAP[params.priority] };
    }

    const created = await this.jiraFetch("/rest/api/3/issue", {
      method: "POST",
      body: JSON.stringify({ fields }),
    });
    return created.key;
  }

  async updateTicket(params: {
    key: string;
    summary?: string;
    description?: string;
    labels?: string[];
    priority?: "P1" | "P2" | "P3" | "P4";
  }): Promise<void> {
    if (!this.isConfigured()) return;

    const fields: Record<string, any> = {};
    if (params.summary) fields.summary = this.truncateSummary(params.summary);
    if (params.description) fields.description = markdownToAdf(params.description);
    if (params.labels) fields.labels = params.labels;
    if (params.priority && PRIORITY_MAP[params.priority]) {
      fields.priority = { name: PRIORITY_MAP[params.priority] };
    }

    await this.jiraFetch(`/rest/api/3/issue/${params.key}`, {
      method: "PUT",
      body: JSON.stringify({ fields }),
    });
    logger.info("jira", `Updated ${params.key}`);
  }

  async findExisting(params: { summaryPrefix: string; labels: string[] }): Promise<string | null> {
    if (!this.isConfigured()) return null;

    const escapedSummary = params.summaryPrefix.replace(/"/g, '\\"');
    const labelClause = params.labels.map((l) => `labels = "${l}"`).join(" AND ");
    const jql = `project = "${JIRA_PROJECT_KEY}" AND summary ~ "${escapedSummary}" AND ${labelClause} AND statusCategory != Done ORDER BY created DESC`;

    try {
      const issues = await this.searchRaw(jql, 1);
      if (issues.length > 0) return issues[0].key;
    } catch (err) {
      logger.warn("jira", `Duplicate search failed (non-blocking): ${(err as Error).message.slice(0, 200)}`);
    }
    return null;
  }

  async transitionTicket(key: string, statusName: string): Promise<void> {
    if (!this.isConfigured()) return;
    const { transitions } = await this.jiraFetch(`/rest/api/3/issue/${key}/transitions`, { method: "GET" });
    const match = transitions.find((t: any) => t.name.toLowerCase() === statusName.toLowerCase());
    if (!match) {
      logger.warn("jira", `No transition named "${statusName}" on ${key}`);
      return;
    }
    await this.jiraFetch(`/rest/api/3/issue/${key}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: match.id } }),
    });
  }

  async comment(key: string, body: string): Promise<void> {
    if (!this.isConfigured()) return;
    await this.jiraFetch(`/rest/api/3/issue/${key}/comment`, {
      method: "POST",
      body: JSON.stringify({ body: markdownToAdf(body) }),
    });
  }

  /** Migrated from the deprecated /rest/api/3/search GET endpoint (Atlassian changelog CHANGE-2046). */
  private async searchRaw(jql: string, maxResults: number): Promise<any[]> {
    const result = await this.jiraFetch("/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify({
        jql,
        maxResults,
        fields: ["summary", "description", "status", "labels", "priority", "parent"],
      }),
    });
    return result.issues ?? [];
  }

  async search(query: { labels?: string[]; excludeStatus?: string[] }, maxResults = 50): Promise<TrackerIssue[]> {
    if (!this.isConfigured()) {
      throw new Error("Jira not configured — set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN");
    }
    const clauses = [`project = "${JIRA_PROJECT_KEY}"`];
    for (const label of query.labels ?? []) clauses.push(`labels = "${label}"`);
    for (const status of query.excludeStatus ?? []) clauses.push(`status != ${status}`);
    const jql = `${clauses.join(" AND ")} ORDER BY created DESC`;

    const rawIssues = await this.searchRaw(jql, maxResults);
    return rawIssues.map((raw) => ({
      key: raw.key,
      summary: raw.fields?.summary ?? "",
      descriptionMarkdown: adfToMarkdown(raw.fields?.description),
      priority: raw.fields?.priority?.name,
      parentKey: raw.fields?.parent?.key ?? null,
    }));
  }
}
