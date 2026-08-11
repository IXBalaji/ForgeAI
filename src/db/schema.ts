import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  uniqueIndex,
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
  status: text("status").notNull().default("open"), // open | in_review | parked | flagged | done
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const deployments = pgTable("deployments", {
  id: id(),
  env: text("env").notNull(),
  commitSha: text("commit_sha").notNull(),
  // The rollback tag (e.g. elms-qa-1a2b3c4) — "redeploy the last-good tag"
  // instead of a git-archaeology exercise, per the guardrails doc.
  tag: text("tag"),
  deployedAt: timestamp("deployed_at", { withTimezone: true }).notNull().defaultNow(),
  status: text("status").notNull(), // succeeded | failed
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
