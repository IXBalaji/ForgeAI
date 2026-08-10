import type { ClassifiedIssue } from "./issue-classifier.js";
import type { PageReport } from "./report-reader.js";

export interface JiraTicketPayload {
  summary: string;
  issueType: string;
  priority: string;
  labels: string[];
  description: JiraAdfDocument;
  classified: ClassifiedIssue;
}

type JiraAdfDocument = {
  type: "doc";
  version: 1;
  content: AdfNode[];
};

type AdfNode =
  | { type: "heading"; attrs: { level: number }; content: AdfInline[] }
  | { type: "paragraph"; content: AdfInline[] }
  | { type: "bulletList"; content: AdfListItem[] }
  | { type: "codeBlock"; attrs: { language?: string }; content: AdfInline[] }
  | { type: "table"; content: AdfTableRow[] }
  | { type: "rule" }
  | { type: "panel"; attrs: { panelType: string }; content: AdfNode[] };

type AdfInline =
  | { type: "text"; text: string; marks?: Array<{ type: string }> }
  | { type: "hardBreak" };

type AdfListItem = { type: "listItem"; content: AdfNode[] };
type AdfTableRow = { type: "tableRow"; content: AdfTableCell[] };
type AdfTableCell = { type: "tableHeader" | "tableCell"; content: AdfNode[] };

function text(t: string, marks?: Array<{ type: string }>): AdfInline {
  return marks ? { type: "text", text: t, marks } : { type: "text", text: t };
}

function bold(t: string): AdfInline {
  return text(t, [{ type: "strong" }]);
}

function paragraph(...inlines: AdfInline[]): AdfNode {
  return { type: "paragraph", content: inlines };
}

function heading(level: number, t: string): AdfNode {
  return { type: "heading", attrs: { level }, content: [text(t)] };
}

function bulletList(items: string[]): AdfNode {
  return {
    type: "bulletList",
    content: items.map((item) => ({
      type: "listItem" as const,
      content: [paragraph(text(item))],
    })),
  };
}

function codeBlock(code: string, language?: string): AdfNode {
  return {
    type: "codeBlock",
    attrs: { language },
    content: [text(code)],
  };
}

function tableRow(cells: AdfNode[][], headerRow = false): AdfTableRow {
  return {
    type: "tableRow",
    content: cells.map((cellContent) => ({
      type: headerRow ? "tableHeader" : "tableCell",
      content: cellContent,
    })),
  };
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

  const content: AdfNode[] = [];

  content.push(
    { type: "panel", attrs: { panelType: "info" }, content: [
      paragraph(
        bold("Issue Type: "), text(ISSUE_TYPE_LABELS[issue.issueType] ?? issue.issueType),
        text(" | "),
        bold("Priority: "), text(issue.priority),
        text(" | "),
        bold("Impact: "), text(issue.impact),
      ),
    ]},
  );

  content.push(heading(2, "Summary"));
  content.push(paragraph(text(issue.description)));
  content.push(paragraph(bold("Classification reason: "), text(issue.issueTypeReason)));

  content.push(heading(2, "Scope"));
  content.push(paragraph(
    bold(`${issue.totalNodeCount}`), text(` affected element(s) across `),
    bold(`${affectedUrls.length}`), text(` page(s)`),
  ));
  content.push(bulletList(urlPaths));

  content.push(heading(2, "WCAG Criteria"));
  content.push(paragraph(text(issue.wcagTags.join(", ") || "best-practice")));

  content.push(heading(2, "Affected Elements"));

  for (const page of issue.affectedPages) {
    const pagePath = (() => { try { return new URL(page.url).pathname; } catch { return page.url; } })();
    content.push(heading(3, pagePath));

    const headerRow = tableRow(
      [
        [paragraph(bold("Selector"))],
        [paragraph(bold("HTML"))],
        [paragraph(bold("Fix"))],
      ],
      true,
    );

    const dataRows = page.nodes.slice(0, 10).map((node) =>
      tableRow([
        [paragraph(text(node.target.join(" ")))],
        [codeBlock(truncate(node.html, 200), "html")],
        [paragraph(text(truncate(node.failureSummary ?? "See rule docs", 200)))],
      ]),
    );

    if (page.nodes.length > 0) {
      content.push({ type: "table", content: [headerRow, ...dataRows] });
    }

    if (page.nodes.length > 10) {
      content.push(paragraph(text(`... and ${page.nodes.length - 10} more elements on this page`)));
    }
  }

  content.push({ type: "rule" });

  content.push(heading(2, "Reference"));
  content.push(bulletList([
    `Rule: ${issue.ruleId}`,
    `Help: ${issue.help}`,
    `Docs: ${issue.helpUrl}`,
    `Scan timestamp: ${scanMeta.timestamp}`,
    `Total pages scanned: ${scanMeta.pageCount}`,
  ]));

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
    description: { type: "doc", version: 1, content },
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
