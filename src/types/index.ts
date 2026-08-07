import { z } from "zod";

export const Severity = z.enum(["critical", "serious", "moderate", "minor"]);
export type Severity = z.infer<typeof Severity>;

export const TicketStatus = z.enum([
  "open",
  "in_review",
  "parked",
  "flagged",
  "done",
]);
export type TicketStatus = z.infer<typeof TicketStatus>;

export const ReviewVerdict = z.enum(["approved", "rejected"]);
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

export const ScanRun = z.object({
  id: z.string(),
  targetEnv: z.string(),
  toolVersions: z.record(z.string(), z.string()),
  startedAt: z.coerce.date(),
  triggeredBy: z.string(),
});
export type ScanRun = z.infer<typeof ScanRun>;

/** One raw accessibility finding from the Scanner agent, before triage. */
export const Issue = z.object({
  id: z.string(),
  scanRunId: z.string(),
  /** hash(wcagRule + selector + pageUrl) — makes re-scans idempotent. */
  fingerprint: z.string(),
  wcagRule: z.string(),
  selector: z.string(),
  pageUrl: z.string(),
  severity: Severity,
  screenshotUrl: z.string().nullable(),
  status: z.enum(["open", "ticketed", "resolved"]),
});
export type Issue = z.infer<typeof Issue>;

/** One Jira story — a category of issues, not a single instance. */
export const Ticket = z.object({
  id: z.string(),
  jiraKey: z.string().nullable(),
  epicKey: z.string().nullable(),
  category: z.string(),
  issueIds: z.array(z.string()),
  status: TicketStatus,
});
export type Ticket = z.infer<typeof Ticket>;

/** One Developer-agent attempt at fixing a ticket. */
export const FixAttempt = z.object({
  id: z.string(),
  ticketId: z.string(),
  branch: z.string(),
  commitSha: z.string().nullable(),
  prUrl: z.string().nullable(),
  developerAgentRunId: z.string(),
  attemptNumber: z.number().int().positive(),
  createdAt: z.coerce.date(),
});
export type FixAttempt = z.infer<typeof FixAttempt>;

/** The Reviewer agent's verdict on one FixAttempt. */
export const ReviewResult = z.object({
  id: z.string(),
  fixAttemptId: z.string(),
  verdict: ReviewVerdict,
  resolvedIssueIds: z.array(z.string()),
  scopeGuardFlagged: z.boolean(),
  comments: z.string(),
  createdAt: z.coerce.date(),
});
export type ReviewResult = z.infer<typeof ReviewResult>;

export const Deployment = z.object({
  id: z.string(),
  env: z.string(),
  commitSha: z.string(),
  tag: z.string().nullable(),
  deployedAt: z.coerce.date(),
  status: z.enum(["succeeded", "failed"]),
});
export type Deployment = z.infer<typeof Deployment>;

export const IterationCycle = z.object({
  id: z.string(),
  cycleNumber: z.number().int().nonnegative(),
  scanRunId: z.string().nullable(),
  epicKey: z.string().nullable(),
  openIssueCount: z.number().int().nonnegative(),
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date().nullable(),
});
export type IterationCycle = z.infer<typeof IterationCycle>;

/** What the Release agent hands the human at the single end-of-cycle checkpoint. */
export const ReleaseReport = z.object({
  cycleId: z.string(),
  prUrl: z.string().nullable(),
  fixedTicketIds: z.array(z.string()),
  parkedTicketIds: z.array(z.string()),
  flaggedTicketIds: z.array(z.string()),
  generatedAt: z.coerce.date(),
});
export type ReleaseReport = z.infer<typeof ReleaseReport>;

/** Shared state threaded through the LangGraph orchestrator. */
export const CycleState = z.object({
  cycleId: z.string().nullable(),
  scanRunId: z.string().nullable(),
  activeTicketIds: z.array(z.string()),
});
export type CycleState = z.infer<typeof CycleState>;
