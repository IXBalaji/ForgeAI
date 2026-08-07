import "dotenv/config";
import { eq } from "drizzle-orm";
import { LABEL_PREFIX, JIRA_PROJECT_KEY } from "../lib/config.js";
import { db } from "../db/client.js";
import { iterationCycles } from "../db/schema.js";

const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;

export function isJiraConfigured(): boolean {
  return Boolean(JIRA_BASE_URL && JIRA_EMAIL && JIRA_API_TOKEN);
}

function authHeader(): string {
  const token = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");
  return `Basic ${token}`;
}

async function jiraFetch(path: string, init: RequestInit): Promise<any> {
  const res = await fetch(`${JIRA_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`Jira API ${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

/**
 * Returns the epic for this iteration cycle, creating it once and reusing it
 * on every subsequent call — a cycle can trigger many triage passes as the
 * loop re-scans, and they must all file under the same epic rather than one
 * each. The reuse is keyed on the IterationCycle row, not a timestamp label,
 * so it's correct however many times triage runs within one cycle.
 */
export async function ensureEpic(cycleId: string): Promise<string | null> {
  const [cycle] = await db.select().from(iterationCycles).where(eq(iterationCycles.id, cycleId));
  if (cycle?.epicKey) return cycle.epicKey;

  if (!isJiraConfigured()) {
    console.warn("[jira] Jira not configured — skipping epic creation.");
    return null;
  }

  const created = await jiraFetch("/rest/api/3/issue", {
    method: "POST",
    body: JSON.stringify({
      fields: {
        project: { key: JIRA_PROJECT_KEY },
        summary: `[${LABEL_PREFIX}] Accessibility remediation cycle ${cycleId}`,
        issuetype: { name: "Epic" },
      },
    }),
  });

  if (cycle) {
    await db.update(iterationCycles).set({ epicKey: created.key }).where(eq(iterationCycles.id, cycleId));
  }
  return created.key;
}

/** Creates a story for one ticket category under the given epic. Returns the story key. */
export async function createTicketStory(params: {
  epicKey: string | null;
  category: string;
  severityCounts: Record<string, number>;
  issueCount: number;
}): Promise<string | null> {
  if (!isJiraConfigured()) {
    console.warn(`[jira] Jira not configured — ticket for "${params.category}" only exists in the local DB.`);
    return null;
  }
  const description = [
    `Accessibility category: ${params.category}`,
    `Instances found: ${params.issueCount}`,
    `Severity breakdown: ${JSON.stringify(params.severityCounts)}`,
  ].join("\n\n");

  const created = await jiraFetch("/rest/api/3/issue", {
    method: "POST",
    body: JSON.stringify({
      fields: {
        project: { key: JIRA_PROJECT_KEY },
        summary: `[${LABEL_PREFIX}] ${params.category}`,
        description: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: description }] }],
        },
        issuetype: { name: "Story" },
        ...(params.epicKey ? { parent: { key: params.epicKey } } : {}),
      },
    }),
  });
  return created.key;
}

export async function transitionTicket(jiraKey: string, transitionName: string): Promise<void> {
  if (!isJiraConfigured()) return;
  const { transitions } = await jiraFetch(`/rest/api/3/issue/${jiraKey}/transitions`, { method: "GET" });
  const match = transitions.find((t: any) => t.name.toLowerCase() === transitionName.toLowerCase());
  if (!match) {
    console.warn(`[jira] No transition named "${transitionName}" on ${jiraKey}`);
    return;
  }
  await jiraFetch(`/rest/api/3/issue/${jiraKey}/transitions`, {
    method: "POST",
    body: JSON.stringify({ transition: { id: match.id } }),
  });
}

export async function commentOnTicket(jiraKey: string, comment: string): Promise<void> {
  if (!isJiraConfigured()) return;
  await jiraFetch(`/rest/api/3/issue/${jiraKey}/comment`, {
    method: "POST",
    body: JSON.stringify({
      body: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: comment }] }],
      },
    }),
  });
}
