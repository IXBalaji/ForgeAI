import type { AggregatedIssue } from "./report-reader.js";
import { CLASSIFIER_MODEL } from "../lib/config.js";
import { traceAnthropicMessagesCreate } from "../observability/anthropic-tracing.js";

export type IssueType = "code_change" | "bad_data" | "infrastructure" | "design";

export interface ClassifiedIssue extends AggregatedIssue {
  issueType: IssueType;
  issueTypeReason: string;
  priority: "P1" | "P2" | "P3" | "P4";
  suggestedLabels: string[];
}

const CLASSIFICATION_PROMPT = `You are an accessibility triage agent. Given an aggregated accessibility violation from an axe-core scan, classify it into one of these issue types:

- **code_change**: The fix requires modifying source code — adding ARIA attributes, fixing HTML semantics, updating component props, adding labels, improving focus management, etc. Most a11y violations fall here.
- **bad_data**: The violation stems from incorrect/missing content data — e.g. images uploaded without alt text, CMS content missing required fields, database records with empty labels.
- **infrastructure**: The violation is caused by infrastructure/build/deployment config — e.g. missing lang attribute from SSR template, CSP blocking needed resources, CDN stripping attributes, build tool misconfiguration.
- **design**: The violation requires a design change — e.g. insufficient color contrast that needs a new color palette, touch targets too small, layout causing focus order issues.

Also assign a priority:
- **P1**: critical impact, blocks users (screen reader users can't navigate, form can't be submitted)
- **P2**: serious impact, significant barrier but workarounds exist
- **P3**: moderate impact, inconvenience but functionality accessible
- **P4**: minor impact, best practice improvement

Respond with ONLY valid JSON (no markdown fences):
{
  "issueType": "code_change" | "bad_data" | "infrastructure" | "design",
  "reason": "one sentence why this classification",
  "priority": "P1" | "P2" | "P3" | "P4",
  "labels": ["up to 3 labels for jira"]
}`;

function buildIssueContext(issue: AggregatedIssue): string {
  const pages = issue.affectedPages
    .map((p) => {
      const selectors = p.nodes.map((n) => `  selector: ${n.target.join(" ")}\n  html: ${n.html}\n  fix: ${n.failureSummary ?? "n/a"}`).join("\n---\n");
      return `Page: ${p.url}\n${selectors}`;
    })
    .join("\n\n");

  return `Rule ID: ${issue.ruleId}
Impact: ${issue.impact}
Description: ${issue.description}
Help: ${issue.help}
WCAG tags: ${issue.wcagTags.join(", ")}
Affected pages: ${issue.affectedPages.length}
Total affected elements: ${issue.totalNodeCount}
Help URL: ${issue.helpUrl}

Affected elements by page:
${pages}`;
}

export async function classifyIssues(issues: AggregatedIssue[]): Promise<ClassifiedIssue[]> {
  const classified: ClassifiedIssue[] = [];

  const batchContext = issues
    .map((issue, i) => `--- Issue ${i + 1} ---\n${buildIssueContext(issue)}`)
    .join("\n\n");

  let results: Array<{ issueType: IssueType; reason: string; priority: string; labels: string[] }>;

  try {
    // The classification rules are static across every call — mark them as an
    // ephemeral cache breakpoint so repeated triage runs don't re-bill this
    // stable prefix. Only the per-batch issue content varies.
    const staticInstructions = `${CLASSIFICATION_PROMPT}\n\nClassify each of these issues. Return a JSON array with one object per issue, in the same order.\n\n`;
    const dynamicContent = `Number of issues in this batch: ${issues.length}\n\n${batchContext}`;
    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: staticInstructions, cache_control: { type: "ephemeral" as const } },
          { type: "text" as const, text: dynamicContent },
        ],
      },
    ];
    const response = await traceAnthropicMessagesCreate(
      {
        agent_name: "triage",
        operation_name: "issue_classification",
        model_name: CLASSIFIER_MODEL,
      },
      {
        issue_count: issues.length,
        operation_name: "issue_classification",
        messages,
      },
      (client) =>
        client.messages.create({
          model: CLASSIFIER_MODEL,
          max_tokens: 2048,
          messages,
        }),
    );

    const raw = response.content[0].type === "text" ? response.content[0].text : "";
    const text = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    try {
      results = JSON.parse(text);
      if (!Array.isArray(results)) results = [results];
    } catch {
      console.warn("[classifier] Failed to parse LLM response, falling back to heuristic classification");
      console.warn("[classifier] Raw response:", raw.slice(0, 300));
      return fallbackClassify(issues);
    }
  } catch (err) {
    console.warn(`[classifier] LLM call failed (${(err as Error).message}), falling back to heuristic classification`);
    return fallbackClassify(issues);
  }

  for (let i = 0; i < issues.length; i++) {
    const r = results[i] ?? { issueType: "code_change", reason: "default", priority: "P3", labels: [] };
    classified.push({
      ...issues[i],
      issueType: r.issueType,
      issueTypeReason: r.reason,
      priority: r.priority as ClassifiedIssue["priority"],
      suggestedLabels: r.labels,
    });
  }

  return classified;
}

function fallbackClassify(issues: AggregatedIssue[]): ClassifiedIssue[] {
  return issues.map((issue) => ({
    ...issue,
    issueType: heuristicClassify(issue),
    issueTypeReason: "heuristic fallback — LLM unavailable",
    priority: impactToPriority(issue.impact),
    suggestedLabels: ["accessibility", issue.impact],
  }));
}

function heuristicClassify(issue: AggregatedIssue): IssueType {
  const colorRules = ["color-contrast", "color-contrast-enhanced"];
  if (colorRules.includes(issue.ruleId)) return "design";

  const dataRules = ["image-alt", "input-image-alt"];
  if (dataRules.includes(issue.ruleId)) return "bad_data";

  const infraRules = ["html-has-lang", "html-lang-valid", "meta-viewport"];
  if (infraRules.includes(issue.ruleId)) return "infrastructure";

  return "code_change";
}

function impactToPriority(impact: string): ClassifiedIssue["priority"] {
  switch (impact) {
    case "critical": return "P1";
    case "serious": return "P2";
    case "moderate": return "P3";
    default: return "P4";
  }
}
