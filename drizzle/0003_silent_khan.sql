CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cycle_id" text NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reports_generated" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cycle_id" text NOT NULL,
	"type" text NOT NULL,
	"file_path" text,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "pr_number" integer;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "pr_url" text;--> statement-breakpoint
ALTER TABLE "fix_attempts" ADD COLUMN "pr_number" integer;--> statement-breakpoint
ALTER TABLE "review_results" ADD COLUMN "findings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "review_results" ADD COLUMN "blocking_findings_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "review_results" ADD COLUMN "pr_review_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_cycle_id_iteration_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."iteration_cycles"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reports_generated" ADD CONSTRAINT "reports_generated_cycle_id_iteration_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."iteration_cycles"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_cycle_idx" ON "audit_log" USING btree ("cycle_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reports_generated_cycle_type_idx" ON "reports_generated" USING btree ("cycle_id","type");