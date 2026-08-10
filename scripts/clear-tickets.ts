import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sql } from "drizzle-orm";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const pool = new Pool({ connectionString });
const db = drizzle(pool);

async function clearJiraLinkedRecords() {
  console.log("Clearing DB records for Jira-linked tickets only...\n");

  const counts = await db.execute(sql`
    WITH
      jira_tickets AS (
        SELECT id FROM tickets WHERE jira_key IS NOT NULL
      ),
      jira_fixes AS (
        SELECT id FROM fix_attempts WHERE ticket_id IN (SELECT id FROM jira_tickets)
      ),
      del_deployments AS (
        DELETE FROM deployments
        WHERE commit_sha IN (
          SELECT commit_sha FROM fix_attempts WHERE id IN (SELECT id FROM jira_fixes) AND commit_sha IS NOT NULL
        )
        RETURNING id
      ),
      del_reviews AS (
        DELETE FROM review_results
        WHERE fix_attempt_id IN (SELECT id FROM jira_fixes)
        RETURNING id
      ),
      del_fixes AS (
        DELETE FROM fix_attempts
        WHERE id IN (SELECT id FROM jira_fixes)
        RETURNING id
      ),
      del_tickets AS (
        DELETE FROM tickets
        WHERE id IN (SELECT id FROM jira_tickets)
        RETURNING id
      ),
      reset_issues AS (
        UPDATE issues SET status = 'open'
        WHERE status = 'ticketed'
          AND id::text IN (
            SELECT jsonb_array_elements_text(issue_ids)
            FROM tickets WHERE id IN (SELECT id FROM jira_tickets)
          )
        RETURNING id
      )
    SELECT
      (SELECT count(*) FROM del_deployments) AS deployments_deleted,
      (SELECT count(*) FROM del_reviews)     AS reviews_deleted,
      (SELECT count(*) FROM del_fixes)       AS fix_attempts_deleted,
      (SELECT count(*) FROM del_tickets)     AS tickets_deleted,
      (SELECT count(*) FROM reset_issues)    AS issues_reset
  `);

  const row = counts.rows[0];
  console.log(`  deployments deleted:     ${row.deployments_deleted}`);
  console.log(`  review_results deleted:  ${row.reviews_deleted}`);
  console.log(`  fix_attempts deleted:    ${row.fix_attempts_deleted}`);
  console.log(`  tickets deleted:         ${row.tickets_deleted}`);
  console.log(`  issues reset to 'open':  ${row.issues_reset}`);
  console.log("\nDone.");
}

clearJiraLinkedRecords()
  .catch((err) => {
    console.error("Failed:", err);
    process.exit(1);
  })
  .finally(() => pool.end());
