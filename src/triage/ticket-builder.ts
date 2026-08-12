import type { ClassifiedIssue } from "./issue-classifier.js";
import type { PageReport } from "./report-reader.js";

export interface JiraTicketPayload {
  summary: string;
  issueType: string;
  priority: string;
  labels: string[];
  description: string;
  classified: ClassifiedIssue;
}

const ISSUE_TYPE_LABELS: Record<string, string> = {
  code_change: "Code Change Required",
  bad_data: "Data/Content Issue",
  infrastructure: "Infrastructure/Config Issue",
  design: "Design Change Required",
};

export function buildTicketPayload(
  issue: ClassifiedIssue,
  labelPrefix: string,
  scanMeta: { timestamp: string; pageCount: number; targetUrl: string },
): JiraTicketPayload {
  const summary = `[${labelPrefix}] A11y: ${issue.help} (${issue.ruleId})`;

  const affectedUrls = [...new Set(issue.affectedPages.map((p) => p.url))];
  const urlPaths = affectedUrls.map((u) => {
    try { return new URL(u).pathname; } catch { return u; }
  });

  const lines: string[] = [];

  lines.push(
    `> Issue Type: **${ISSUE_TYPE_LABELS[issue.issueType] ?? issue.issueType}** | Priority: **${issue.priority}** | Impact: **${issue.impact}**`,
  );

  lines.push("## Summary");
  lines.push(issue.description);
  lines.push(`**Classification reason:** ${issue.issueTypeReason}`);

  lines.push("## Scope");
  lines.push(`**${issue.totalNodeCount}** affected element(s) across **${affectedUrls.length}** page(s)`);
  for (const path of urlPaths) lines.push(`- ${path}`);

  lines.push("## WCAG Criteria");
  lines.push(issue.wcagTags.join(", ") || "best-practice");

  lines.push("## Affected Elements");

  for (const page of issue.affectedPages) {
    const pagePath = (() => { try { return new URL(page.url).pathname; } catch { return page.url; } })();
    lines.push(`### ${pagePath}`);

    if (page.nodes.length > 0) {
      lines.push("| Selector | HTML | Fix |");
      lines.push("| --- | --- | --- |");
      for (const node of page.nodes.slice(0, 10)) {
        const selector = node.target.join(" ");
        const html = truncate(node.html, 200).replace(/\|/g, "\\|");
        const fix = truncate(node.failureSummary ?? "See rule docs", 200).replace(/\|/g, "\\|");
        lines.push(`| ${selector} | ${html} | ${fix} |`);
      }
    }

    if (page.nodes.length > 10) {
      lines.push(`... and ${page.nodes.length - 10} more elements on this page`);
    }
  }

  lines.push("---");

  lines.push("## Reference");
  lines.push(`- Rule: ${issue.ruleId}`);
  lines.push(`- Help: ${issue.help}`);
  lines.push(`- Docs: ${issue.helpUrl}`);
  lines.push(`- Scan timestamp: ${scanMeta.timestamp}`);
  lines.push(`- Total pages scanned: ${scanMeta.pageCount}`);

  return {
    summary: truncate(summary, 255),
    issueType: issue.issueType,
    priority: issue.priority,
    labels: [
      "accessibility",
      `a11y-${issue.impact}`,
      `a11y-${issue.issueType.replace(/_/g, "-")}`,
      ...issue.suggestedLabels.filter((l) => !l.startsWith("a11y-")),
    ],
    description: lines.join("\n"),
    classified: issue,
  };
}

export function buildTicketPayloads(
  issues: ClassifiedIssue[],
  labelPrefix: string,
  pages: PageReport[],
): JiraTicketPayload[] {
  const timestamps = pages.map((p) => p.timestamp).filter(Boolean).sort();
  const scanMeta = {
    timestamp: timestamps[timestamps.length - 1] ?? new Date().toISOString(),
    pageCount: pages.length,
    targetUrl: pages[0]?.url ?? "unknown",
  };

  return issues.map((issue) => buildTicketPayload(issue, labelPrefix, scanMeta));
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}
