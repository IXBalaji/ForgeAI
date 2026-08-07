import "dotenv/config";

/**
 * PROJECT_KEY identifies the target application this instance of the agent
 * system is running against (e.g. "ELMS" for employee-leave-management-system).
 * This system is meant to be reused across target projects, so nothing here
 * should hardcode a label belonging to any one of them — every per-project
 * label derives from this single required value instead.
 */
const PROJECT_KEY = process.env.PROJECT_KEY;
if (!PROJECT_KEY) {
  throw new Error(
    "PROJECT_KEY is not set — this identifies which target project's tickets/branches/PRs " +
      'you\'re generating (e.g. PROJECT_KEY="ELMS"). Set it in .env.',
  );
}

/**
 * The label used in branch names, commit messages, PR titles, and Jira ticket
 * summaries — e.g. PROJECT_KEY="ELMS" produces branches like elms/<id>, PRs
 * titled "[ELMS] Fix: ...", and Jira summaries "[ELMS] <category>". Override
 * TICKET_LABEL_PREFIX only if you want the GitHub-facing label to differ from
 * PROJECT_KEY itself (rare).
 */
export const LABEL_PREFIX = process.env.TICKET_LABEL_PREFIX ?? PROJECT_KEY;

export const LABEL_PREFIX_SLUG = LABEL_PREFIX.toLowerCase();

/** The actual Jira project key to file tickets under — defaults to PROJECT_KEY. */
export const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY ?? PROJECT_KEY;

export { PROJECT_KEY };

/**
 * Model/effort tiering for cost efficiency (architecture doc §06): Sonnet
 * instead of Opus for both agents that call Claude directly, since neither
 * needs frontier-model reasoning for a single scoped accessibility fix or
 * review — Opus is the override for cases that need it, not the default.
 * Developer runs at higher effort (it's generating the actual fix); Reviewer
 * at medium (it's verifying, not authoring).
 */
export const DEVELOPER_MODEL = process.env.CLAUDE_DEVELOPER_MODEL ?? "claude-sonnet-5";
export const DEVELOPER_EFFORT = process.env.CLAUDE_DEVELOPER_EFFORT ?? "high";
export const REVIEWER_MODEL = process.env.CLAUDE_REVIEWER_MODEL ?? "claude-sonnet-5";
export const REVIEWER_EFFORT = process.env.CLAUDE_REVIEWER_EFFORT ?? "medium";
