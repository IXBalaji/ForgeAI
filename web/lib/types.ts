export type Stage =
  | "scan"
  | "triage"
  | "fix"
  | "review"
  | "autofix"
  | "deploy"
  | "cleanup"
  | "verify"
  | "release"
  | "unknown";

export type RunMode = "scan" | "triage" | "full";

export interface RunStatus {
  cycleId: string;
  mode: RunMode;
  startedAt: string;
  endedAt: string | null;
  stage: Stage;
  stageDetail: string | null;
  loopIterationHint: number | null;
  counts: {
    ticketsOpen: number;
    ticketsInProgress: number;
    ticketsInReview: number;
    ticketsParked: number;
    ticketsFlagged: number;
    ticketsDone: number;
    fixAttempts: number;
    reviewsApproved: number;
    reviewsRejected: number;
    deployments: number;
  };
  recentLog: string[];
  processAlive: boolean;
  failed: boolean;
  exitCode: number | null;
  result: {
    fixed: Array<{ id: string; jiraKey: string | null; category: string }>;
    parked: Array<{ id: string; jiraKey: string | null; category: string }>;
    flagged: Array<{ id: string; jiraKey: string | null; category: string }>;
    // Tickets still awaiting a fix — the deliverable of "triage" mode, and
    // also non-empty for a "full" run that hit MAX_CYCLES with work left.
    open: Array<{ id: string; jiraKey: string | null; category: string }>;
    prUrl: string | null;
  } | null;
  logsByStage: Record<Stage, string[]>;
  failureCategory: string | null;
  failureReason: string | null;
}

export type Severity = "critical" | "serious" | "moderate" | "minor";

export type TicketStatus = "open" | "in_progress" | "in_review" | "parked" | "flagged" | "done";

export interface IssueNode {
  selector: string;
  html: string;
  failureSummary: string | null;
}

export interface IssueGroup {
  ruleId: string;
  severity: Severity;
  help: string;
  helpUrl: string;
  wcag: string[];
  elementCount: number;
  pageCount: number;
  pages: Array<{ url: string; state: string; nodes: IssueNode[] }>;
}

export interface ScanResults {
  /** false when no report from this run's time window is on disk (e.g. overwritten by a later run). */
  available: boolean;
  statesScanned: number;
  pagesScanned: number;
  elementCount: number;
  bySeverity: Record<Severity, number>;
  groups: IssueGroup[];
}

export interface TicketRow {
  id: string;
  jiraKey: string | null;
  jiraUrl: string | null;
  category: string;
  status: TicketStatus;
  /** Created during this run, as opposed to an existing ticket refreshed with new scan data. */
  isNew: boolean;
  severity: Severity | null;
  issueCount: number;
  pageCount: number;
  attempts: number;
  reviewVerdict: "approved" | "rejected" | null;
  prUrl: string | null;
}

export interface RunResults {
  mode: RunMode;
  scan: ScanResults;
  /** null for scan-only runs — no tickets are created. */
  tickets: TicketRow[] | null;
}

export interface ActiveRun {
  active: boolean | "stalled";
  cycleId?: string;
  startedAt?: string;
}

export interface StartResponse {
  cycleId: string;
  pid: number;
  startedAt: string;
}

export interface ConflictResponse {
  error: "already_running" | "stalled";
  cycleId: string;
  startedAt: string;
}
