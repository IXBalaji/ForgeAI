/**
 * Read-only mirror of src/db/schema.ts.
 *
 * Source of truth: C:\Projects\prospect -01\ForgeAI\src\db\schema.ts
 * Migrations are owned by the root package's drizzle-kit — this copy is purely
 * for SELECT queries from the Next.js app, never INSERT/UPDATE/DELETE (those
 * happen via the spawned orchestrator child process).
 *
 * Keep this in sync manually when the root schema changes (or add a simple sync
 * check script later if drift becomes an issue).
 */
import { pgTable, text, timestamp, integer, boolean, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
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
    severity: text("severity").notNull(),
    screenshotUrl: text("screenshot_url"),
    status: text("status").notNull().default("open"),
  },
  (table) => [uniqueIndex("issues_fingerprint_idx").on(table.fingerprint)],
);

export const tickets = pgTable("tickets", {
  id: id(),
  jiraKey: text("jira_key"),
  epicKey: text("epic_key"),
  category: text("category").notNull(),
  issueIds: jsonb("issue_ids").notNull().default([]),
  status: text("status").notNull().default("open"),
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
  verdict: text("verdict").notNull(),
  resolvedIssueIds: jsonb("resolved_issue_ids").notNull().default([]),
  scopeGuardFlagged: boolean("scope_guard_flagged").notNull().default(false),
  comments: text("comments").notNull().default(""),
  findings: jsonb("findings").notNull().default([]),
  blockingFindingsCount: integer("blocking_findings_count").notNull().default(0),
  prReviewId: text("pr_review_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const deployments = pgTable("deployments", {
  id: id(),
  env: text("env").notNull(),
  commitSha: text("commit_sha").notNull(),
  tag: text("tag"),
  prNumber: integer("pr_number"),
  prUrl: text("pr_url"),
  deployedAt: timestamp("deployed_at", { withTimezone: true }).notNull().defaultNow(),
  status: text("status").notNull(),
});

export const iterationCycles = pgTable("iteration_cycles", {
  id: id(),
  cycleNumber: integer("cycle_number").notNull(),
  scanRunId: text("scan_run_id").references(() => scanRuns.id),
  epicKey: text("epic_key"),
  openIssueCount: integer("open_issue_count").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    cycleId: text("cycle_id")
      .notNull()
      .references(() => iterationCycles.id),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
    action: text("action").notNull(),
    actor: text("actor").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    details: jsonb("details").notNull().default({}),
    status: text("status").notNull(),
  },
  (table) => [index("audit_log_cycle_idx").on(table.cycleId)],
);

export const reportsGenerated = pgTable(
  "reports_generated",
  {
    id: id(),
    cycleId: text("cycle_id")
      .notNull()
      .references(() => iterationCycles.id),
    type: text("type").notNull(),
    filePath: text("file_path"),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("reports_generated_cycle_type_idx").on(table.cycleId, table.type)],
);
