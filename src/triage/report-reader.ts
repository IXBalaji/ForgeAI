import fs from "node:fs";
import path from "node:path";

export interface ReportViolationNode {
  target: string[];
  html: string;
  failureSummary: string | null;
  impact: string;
}

export interface ReportViolation {
  id: string;
  impact: string;
  description: string;
  help: string;
  helpUrl: string;
  tags: string[];
  nodes: ReportViolationNode[];
}

export interface PageReport {
  fileSlug: string;
  url: string;
  timestamp: string;
  violations: ReportViolation[];
  passCount: number;
}

export interface AggregatedIssue {
  ruleId: string;
  impact: string;
  description: string;
  help: string;
  helpUrl: string;
  wcagTags: string[];
  affectedPages: {
    url: string;
    fileSlug: string;
    nodes: ReportViolationNode[];
  }[];
  totalNodeCount: number;
}

export function readReportDir(reportDir: string): PageReport[] {
  if (!fs.existsSync(reportDir)) {
    throw new Error(`Report directory not found: ${reportDir}`);
  }

  const files = fs.readdirSync(reportDir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    throw new Error(`No JSON report files found in ${reportDir}`);
  }

  return files.map((file) => {
    const raw = JSON.parse(fs.readFileSync(path.join(reportDir, file), "utf-8"));
    return {
      fileSlug: file.replace(/\.json$/, ""),
      url: raw.url,
      timestamp: raw.timestamp,
      violations: raw.violations ?? [],
      passCount: raw.passes?.length ?? 0,
    };
  });
}

export function aggregateByRule(pages: PageReport[]): AggregatedIssue[] {
  const byRule = new Map<string, AggregatedIssue>();

  for (const page of pages) {
    for (const violation of page.violations) {
      let entry = byRule.get(violation.id);
      if (!entry) {
        entry = {
          ruleId: violation.id,
          impact: violation.impact,
          description: violation.description,
          help: violation.help,
          helpUrl: violation.helpUrl,
          wcagTags: violation.tags.filter((t) => t.startsWith("wcag")),
          affectedPages: [],
          totalNodeCount: 0,
        };
        byRule.set(violation.id, entry);
      }
      entry.affectedPages.push({
        url: page.url,
        fileSlug: page.fileSlug,
        nodes: violation.nodes,
      });
      entry.totalNodeCount += violation.nodes.length;
    }
  }

  const impactRank: Record<string, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  return [...byRule.values()].sort(
    (a, b) => (impactRank[a.impact] ?? 4) - (impactRank[b.impact] ?? 4),
  );
}
