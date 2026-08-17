import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const id = () =>
  text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`);

export const scanRuns = pgTable("scan_runs", {
  id: id(),
  targetEnv: text("target_env").notNull(),
  toolVersions: jsonb("tool_versions").notNull().default({}),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  triggeredBy: text("triggered_by").notNull(),
});

export const issues = pgTable(
  "issues",
  {
    id: id(),
    scanRunId: text("scan_run_id")
      .notNull()
      .references(() => scanRuns.id),
    fingerprint: text("fingerprint").notNull(),
    wcagRule: text("wcag_rule").notNull(),
    selector: text("selector").notNull(),
    pageUrl: text("page_url").notNull(),
    severity: text("severity").notNull(), // critical | serious | moderate | minor
    screenshotUrl: text("screenshot_url"),
    status: text("status").notNull().default("open"), // open | ticketed | resolved
  },
  (table) => [uniqueIndex("issues_fingerprint_idx").on(table.fingerprint)],
);

export const tickets = pgTable("tickets", {
  id: id(),
  jiraKey: text("jira_key"),
  epicKey: text("epic_key"),
  category: text("category").notNull(),
  issueIds: jsonb("issue_ids").notNull().default([]),
  status: text("status").notNull().default("open"), // open | in_progress | in_review | parked | flagged | done
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const fixAttempts = pgTable("fix_attempts", {
  id: id(),
  ticketId: text("ticket_id")
    .notNull()
    .references(() => tickets.id),
  branch: text("branch").notNull(),
  commitSha: text("commit_sha"),
  pushStatus: text("push_status").notNull().default("pending"),
  prUrl: text("pr_url"),
  prNumber: integer("pr_number"),
  developerAgentRunId: text("developer_agent_run_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const reviewResults = pgTable("review_results", {
  id: id(),
  fixAttemptId: text("fix_attempt_id")
    .notNull()
    .references(() => fixAttempts.id),
  verdict: text("verdict").notNull(), // approved | rejected
  resolvedIssueIds: jsonb("resolved_issue_ids").notNull().default([]),
  scopeGuardFlagged: boolean("scope_guard_flagged").notNull().default(false),
  comments: text("comments").notNull().default(""),
  // Structured findings from the adversarial review pass, both severities.
  findings: jsonb("findings").notNull().default([]),
  blockingFindingsCount: integer("blocking_findings_count").notNull().default(0),
  // GitHub PR review id this pass posted, if any — dedupes re-posting on retry.
  prReviewId: text("pr_review_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const deployments = pgTable("deployments", {
  id: id(),
  env: text("env").notNull(),
  commitSha: text("commit_sha").notNull(),
  // The rollback tag (e.g. elms-qa-1a2b3c4) — "redeploy the last-good tag"
  // instead of a git-archaeology exercise, per the guardrails doc.
  tag: text("tag"),
  prNumber: integer("pr_number"),
  prUrl: text("pr_url"),
  deployedAt: timestamp("deployed_at", { withTimezone: true }).notNull().defaultNow(),
  status: text("status").notNull(), // succeeded | failed | blocked
});

export const iterationCycles = pgTable("iteration_cycles", {
  id: id(),
  cycleNumber: integer("cycle_number").notNull(),
  // Nullable: the cycle row is created before the first scan of the loop runs.
  scanRunId: text("scan_run_id").references(() => scanRuns.id),
  // One epic per cycle, reused across every triage call in that cycle rather
  // than created fresh each time — see integrations/jira.ts's ensureEpic().
  epicKey: text("epic_key"),
  openIssueCount: integer("open_issue_count").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

// Append-only audit trail for every workflow-visible action (PR lifecycle,
// Jira calls, emails). Kept in Postgres alongside the rest of the pipeline's
// state so it's queryable with the same tooling as everything else, rather
// than a separate log-file format. `details` must always be pre-sanitized
// (see observability/sanitize.ts::redactSecrets) before insertion.
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    cycleId: text("cycle_id")
      .notNull()
      .references(() => iterationCycles.id),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
    action: text("action").notNull(), // e.g. "pr.created", "pr.merged", "jira.transition", "email.sent"
    actor: text("actor").notNull(), // orchestrator | reviewer | developer | deploy
    entityType: text("entity_type"), // ticket | pull_request | epic | cycle
    entityId: text("entity_id"),
    details: jsonb("details").notNull().default({}),
    status: text("status").notNull(), // success | failure
  },
  (table) => [index("audit_log_cycle_idx").on(table.cycleId)],
);

// Dedup guard for reports/emails: a unique (cycleId, type) row prevents a
// retried/resumed cycle from re-generating a report or re-sending an email.
export const reportsGenerated = pgTable(
  "reports_generated",
  {
    id: id(),
    cycleId: text("cycle_id")
      .notNull()
      .references(() => iterationCycles.id),
    type: text("type").notNull(), // pre_process_email | post_process_email | final_report
    filePath: text("file_path"),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("reports_generated_cycle_type_idx").on(table.cycleId, table.type)],
);
