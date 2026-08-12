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

/** Base URL of the Jira instance (e.g. "https://foo.atlassian.net") — used to link tickets. */
export const JIRA_BASE_URL = process.env.JIRA_BASE_URL;

export { PROJECT_KEY };

/**
 * Model/effort tiering for cost efficiency. Developer/Reviewer/Conflict-resolver
 * default to Haiku 4.5 — the model that was actually running (and driving the
 * known-good ~$0.10/ticket cost baseline) before this project's SDK upgrade.
 * Override via env if a target project's fixes need Sonnet/Opus-level
 * reasoning; that's an explicit opt-in, not the default.
 */
export const CLASSIFIER_MODEL = process.env.CLASSIFIER_MODEL ?? "claude-haiku-4-5-20251001";
export const DEVELOPER_MODEL = process.env.CLAUDE_DEVELOPER_MODEL ?? "claude-haiku-4-5-20251001";
/**
 * "high" enables deep adaptive thinking, which is billed as output tokens —
 * expensive on a per-turn agentic session and not needed for a scoped,
 * mostly mechanical accessibility fix. Kept at "low" (with thinking disabled
 * below) regardless of which model is configured above.
 */
export const DEVELOPER_EFFORT = process.env.CLAUDE_DEVELOPER_EFFORT ?? "medium";
export const REVIEWER_MODEL = process.env.CLAUDE_REVIEWER_MODEL ?? "claude-haiku-4-5-20251001";
export const REVIEWER_EFFORT = process.env.CLAUDE_REVIEWER_EFFORT ?? "medium";

/**
 * Caps how many agentic turns a single Developer/Autofix/Conflict-resolver SDK
 * session may take. Without a cap, a session with Bash/Read/Write/Edit access
 * can explore and iterate indefinitely, which is a dominant driver of
 * per-ticket token cost. Combined with low effort (above), 20 turns is still
 * generous for a normal single-category accessibility fix.
 */
export const DEVELOPER_MAX_TURNS = parseInt(process.env.CLAUDE_DEVELOPER_MAX_TURNS ?? "20", 10);

/**
 * Selects which VCS host / issue tracker adapter this deployment uses.
 * One provider per deployment — set once at startup, no runtime switching.
 * Defaults preserve today's only-ever-used configuration.
 */
export const VCS_PROVIDER = process.env.VCS_PROVIDER ?? "github";
export const TRACKER_PROVIDER = process.env.TRACKER_PROVIDER ?? "jira";
