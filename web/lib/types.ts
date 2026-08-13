export type Stage =
  | "scan"
  | "triage"
  | "fix"
  | "review"
  | "autofix"
  | "deploy"
  | "cleanup"
  | "release"
  | "unknown";

export interface RunStatus {
  cycleId: string;
  startedAt: string;
  endedAt: string | null;
  stage: Stage;
  stageDetail: string | null;
  loopIterationHint: number | null;
  counts: {
    ticketsOpen: number;
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
    prUrl: string | null;
  } | null;
  logsByStage: Record<Stage, string[]>;
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
