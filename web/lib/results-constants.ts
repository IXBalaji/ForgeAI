import type { RunMode, Severity, Stage, TicketStatus } from "./types";

// ── Domain values ─────────────────────────────────────────────────────

/** Most severe first — drives sort order everywhere results are listed. */
export const SEVERITIES: readonly Severity[] = ["critical", "serious", "moderate", "minor"];

/** Axe results with a null/unknown impact are ranked as the least severe. */
export const FALLBACK_SEVERITY: Severity = "minor";

export const RUN_MODE = {
  scan: "scan",
  triage: "triage",
  full: "full",
} as const satisfies Record<RunMode, RunMode>;

export const TICKET_STATUS = {
  open: "open",
  inProgress: "in_progress",
  inReview: "in_review",
  parked: "parked",
  flagged: "flagged",
  done: "done",
} as const satisfies Record<string, TicketStatus>;

export const REVIEW_VERDICT = {
  approved: "approved",
  rejected: "rejected",
} as const;

// ── Report parsing ────────────────────────────────────────────────────

export const REPORT_DIR_NAME = "a11y-reports";
export const REPORT_FILE_EXT = ".json";
export const REPORT_HTML_FILE = "index.html";

/** axe tag like "wcag143" → WCAG success criterion "1.4.3". */
export const WCAG_CRITERION_TAG = /^wcag(\d)(\d)(\d+)$/;

/** HTML snippets are trimmed server-side — a single node can carry kilobytes of markup. */
export const HTML_SNIPPET_MAX_LENGTH = 400;
export const TRUNCATION_SUFFIX = "…";

export const JIRA_BROWSE_PATH = "/browse/";

// ── Live activity feed (running view) ────────────────────────────────

/** Matches a pipeline log line's leading "[tag]", e.g. "[triage] Found 26 page reports". */
export const ACTIVITY_TAG_PATTERN = /^\[([a-z][a-z0-9_-]*)\]/;

/** Startup/diagnostic tags that are noise to a user watching a run, not pipeline activity. */
export const EXCLUDED_ACTIVITY_TAGS = ["observability", "email", "audit-log"];

/** Lines shown in the live feed before older ones scroll out of view. */
export const ACTIVITY_FEED_LIMIT = 12;

export const STAGE_LABEL: Record<Stage, string> = {
  scan: "Scan",
  triage: "Classify",
  fix: "Fix",
  review: "Review",
  autofix: "Autofix",
  deploy: "Deploy",
  cleanup: "Cleanup",
  verify: "Verify",
  release: "Release",
  unknown: "Working",
};

/** Same guard as the status route — cycleIds never reach a path or query unvalidated. */
export const CYCLE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export const API_ERROR = {
  invalidCycleId: "Invalid cycleId format",
  cycleNotFound: "Cycle not found",
  resultsFailed: "Failed to load results",
  reportNotFound: "HTML report not found",
} as const;

export const resultsApiPath = (cycleId: string) => `/api/workflow/${cycleId}/results`;
export const reportApiPath = (cycleId: string) => `/api/workflow/${cycleId}/report`;

// ── UI ────────────────────────────────────────────────────────────────

/** Elements shown per page before the "+N more" line. */
export const NODES_PREVIEW_LIMIT = 5;

export const MODE_LABEL: Record<RunMode, string> = {
  scan: "Scan report",
  triage: "Scan + classify",
  full: "Scan + classify + fix",
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  serious: "Serious",
  moderate: "Moderate",
  minor: "Minor",
};

export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  in_review: "In review",
  parked: "Parked",
  flagged: "Flagged",
  done: "Fixed",
};

export const REVIEW_VERDICT_LABEL: Record<(typeof REVIEW_VERDICT)[keyof typeof REVIEW_VERDICT], string> = {
  approved: "Approved",
  rejected: "Changes requested",
};

export const RESULTS_COPY = {
  titleComplete: "Run complete",
  titleFailed: "Run failed",
  loading: "Loading results…",
  loadError: "Couldn't load results for this run.",
  openReport: "Open HTML report",
  startAnother: "Start another run",
  starting: "Starting…",
  viewPr: "View pull request",
  none: "—",

  statViolations: "Violation types",
  statElements: "Elements",
  statPages: "Pages scanned",
  statTickets: "Tickets",
  ticketsDetail: (created: number, updated: number) => `${created} new · ${updated} updated`,
  opensInNewTab: "(opens in new tab)",
  issueCountDetail: (n: number) => `${n} issue${n === 1 ? "" : "s"}`,
  statFixed: "Tickets fixed",
  statOutstanding: "Tickets outstanding",
  statNeedsAttention: "Tickets parked / flagged",

  issuesTitle: "Issues found",
  issuesTitleFull: "Issues remaining",
  issuesHintFull: "From the final verification scan — anything listed here was not fixed.",
  issuesEmpty: (pages: number) => `No violations found across ${pages} page${pages === 1 ? "" : "s"}.`,
  issuesUnavailable: "Scan reports for this run are no longer on disk — a later run has overwritten them.",
  statesSuffix: (states: number) => `${states} state${states === 1 ? "" : "s"}`,
  moreNodes: (n: number) => `+${n} more element${n === 1 ? "" : "s"}`,

  ticketsTitle: "Tickets",
  ticketsTitleFull: "Tickets & fixes",
  ticketsEmpty: "No tickets were needed for this run.",
  tagNew: "New",
  tagUpdated: "Updated",
  noJiraKey: "Not in Jira",

  colSeverity: "Severity",
  colRule: "Rule",
  colWcag: "WCAG",
  colPages: "Pages",
  colElements: "Elements",
  colTicket: "Ticket",
  colCategory: "Category",
  colIssues: "Issues",
  colChange: "Change",
  colStatus: "Status",
  colAttempts: "Attempts",
  colReview: "Review",
  colPr: "PR",

  nowRunningTitle: "Now running",
  feedEmpty: "Waiting for the first log line…",
  feedLabel: "Pipeline activity",
} as const;
