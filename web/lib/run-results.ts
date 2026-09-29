import type { IssueGroup, ScanResults, Severity, TicketRow, TicketStatus } from "./types";
import {
  FALLBACK_SEVERITY,
  HTML_SNIPPET_MAX_LENGTH,
  JIRA_BROWSE_PATH,
  REVIEW_VERDICT,
  SEVERITIES,
  TRUNCATION_SUFFIX,
  WCAG_CRITERION_TAG,
} from "./results-constants";

/**
 * Pure shaping of a run's results for the unified results view — no DB or
 * filesystem access, so it's unit-testable. The API route does the I/O.
 */

/** The subset of an axe-core results JSON file this view reads. */
export interface AxeReport {
  url: string;
  timestamp: string;
  violations: Array<{
    id: string;
    impact: string | null;
    help: string;
    helpUrl: string;
    tags: string[];
    nodes: Array<{ target: string[]; html: string; failureSummary: string | null }>;
  }>;
}

export interface RunWindow {
  startedAt: Date;
  endedAt: Date | null;
}

export function severityRank(severity: Severity | null): number {
  return severity ? SEVERITIES.indexOf(severity) : SEVERITIES.length;
}

export function toSeverity(value: string | null | undefined): Severity {
  return SEVERITIES.includes(value as Severity) ? (value as Severity) : FALLBACK_SEVERITY;
}

function emptySeverityCounts(): Record<Severity, number> {
  return Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
}

function truncate(text: string): string {
  return text.length > HTML_SNIPPET_MAX_LENGTH ? text.slice(0, HTML_SNIPPET_MAX_LENGTH) + TRUNCATION_SUFFIX : text;
}

function wcagCriteria(tags: string[]): string[] {
  const criteria: string[] = [];
  for (const tag of tags) {
    const m = tag.match(WCAG_CRITERION_TAG);
    if (m) criteria.push(`${m[1]}.${m[2]}.${m[3]}`);
  }
  return criteria;
}

function inWindow(timestamp: string, window: RunWindow): boolean {
  const t = new Date(timestamp).getTime();
  if (Number.isNaN(t) || t < window.startedAt.getTime()) return false;
  return window.endedAt === null || t <= window.endedAt.getTime();
}

/**
 * Aggregates per-page-state axe reports into one group per rule. Reports are
 * overwritten by every scan, so only those timestamped inside this run's
 * window count — anything else belongs to an earlier or later run.
 */
export function buildScanResults(
  reports: Array<{ state: string; report: AxeReport }>,
  window: RunWindow,
): ScanResults {
  const current = reports.filter((r) => inWindow(r.report.timestamp, window));
  const byRule = new Map<string, IssueGroup>();
  let elementCount = 0;

  for (const { state, report } of current) {
    for (const v of report.violations ?? []) {
      let group = byRule.get(v.id);
      if (!group) {
        group = {
          ruleId: v.id,
          severity: toSeverity(v.impact),
          help: v.help,
          helpUrl: v.helpUrl,
          wcag: wcagCriteria(v.tags ?? []),
          elementCount: 0,
          pageCount: 0,
          pages: [],
        };
        byRule.set(v.id, group);
      }
      group.pages.push({
        url: report.url,
        state,
        nodes: v.nodes.map((n) => ({
          selector: n.target.join(" "),
          html: truncate(n.html ?? ""),
          failureSummary: n.failureSummary ?? null,
        })),
      });
      group.elementCount += v.nodes.length;
      elementCount += v.nodes.length;
    }
  }

  const groups = [...byRule.values()];
  const bySeverity = emptySeverityCounts();
  for (const g of groups) {
    g.pageCount = new Set(g.pages.map((p) => p.url)).size;
    bySeverity[g.severity] += 1;
  }
  groups.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.elementCount - a.elementCount);

  return {
    available: current.length > 0,
    statesScanned: current.length,
    pagesScanned: new Set(current.map((r) => r.report.url)).size,
    elementCount,
    bySeverity,
    groups,
  };
}

export interface TicketInput {
  id: string;
  jiraKey: string | null;
  category: string;
  status: string;
  issueIds: unknown;
  createdAt: Date;
}

export interface TicketRowsInput {
  tickets: TicketInput[];
  issues: Array<{ id: string; severity: string; pageUrl: string }>;
  attempts: Array<{ id: string; ticketId: string; prUrl: string | null; createdAt: Date }>;
  reviews: Array<{ fixAttemptId: string; verdict: string; createdAt: Date }>;
  startedAt: Date;
  jiraBaseUrl: string | undefined;
}

function jiraUrl(base: string | undefined, key: string | null): string | null {
  if (!base || !key) return null;
  return `${base.replace(/\/+$/, "")}${JIRA_BROWSE_PATH}${encodeURIComponent(key)}`;
}

function latest<T extends { createdAt: Date }>(rows: T[]): T | undefined {
  return rows.reduce<T | undefined>((acc, r) => (!acc || r.createdAt > acc.createdAt ? r : acc), undefined);
}

/** One row per ticket, joined with its issues, fix attempts and latest review. */
export function buildTicketRows(input: TicketRowsInput): TicketRow[] {
  const issuesById = new Map(input.issues.map((i) => [i.id, i]));

  const rows = input.tickets.map((t): TicketRow => {
    const ids = Array.isArray(t.issueIds) ? (t.issueIds as string[]) : [];
    const ticketIssues = ids.map((id) => issuesById.get(id)).filter((i) => i !== undefined);
    const severity = ticketIssues.reduce<Severity | null>((worst, i) => {
      const s = toSeverity(i.severity);
      return severityRank(s) < severityRank(worst) ? s : worst;
    }, null);

    const attempts = input.attempts.filter((a) => a.ticketId === t.id);
    const attemptIds = new Set(attempts.map((a) => a.id));
    const review = latest(input.reviews.filter((r) => attemptIds.has(r.fixAttemptId)));
    const withPr = latest(attempts.filter((a) => a.prUrl));

    return {
      id: t.id,
      jiraKey: t.jiraKey,
      jiraUrl: jiraUrl(input.jiraBaseUrl, t.jiraKey),
      category: t.category,
      status: t.status as TicketStatus,
      isNew: t.createdAt >= input.startedAt,
      severity,
      issueCount: ids.length,
      pageCount: new Set(ticketIssues.map((i) => i.pageUrl)).size,
      attempts: attempts.length,
      reviewVerdict:
        review?.verdict === REVIEW_VERDICT.approved || review?.verdict === REVIEW_VERDICT.rejected ? review.verdict : null,
      prUrl: withPr?.prUrl ?? null,
    };
  });

  return rows.sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || (a.jiraKey ?? a.id).localeCompare(b.jiraKey ?? b.id),
  );
}
