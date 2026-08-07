CREATE TABLE IF NOT EXISTS "deployments" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"env" text NOT NULL,
	"commit_sha" text NOT NULL,
	"deployed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fix_attempts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" text NOT NULL,
	"branch" text NOT NULL,
	"commit_sha" text,
	"pr_url" text,
	"developer_agent_run_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issues" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_run_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"wcag_rule" text NOT NULL,
	"selector" text NOT NULL,
	"page_url" text NOT NULL,
	"severity" text NOT NULL,
	"screenshot_url" text,
	"status" text DEFAULT 'open' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "iteration_cycles" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cycle_number" integer NOT NULL,
	"scan_run_id" text,
	"open_issue_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_results" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fix_attempt_id" text NOT NULL,
	"verdict" text NOT NULL,
	"resolved_issue_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scope_guard_flagged" boolean DEFAULT false NOT NULL,
	"comments" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scan_runs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_env" text NOT NULL,
	"tool_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"triggered_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tickets" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jira_key" text,
	"epic_key" text,
	"category" text NOT NULL,
	"issue_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fix_attempts" ADD CONSTRAINT "fix_attempts_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issues" ADD CONSTRAINT "issues_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "iteration_cycles" ADD CONSTRAINT "iteration_cycles_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_results" ADD CONSTRAINT "review_results_fix_attempt_id_fix_attempts_id_fk" FOREIGN KEY ("fix_attempt_id") REFERENCES "public"."fix_attempts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_fingerprint_idx" ON "issues" USING btree ("fingerprint");