import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { tickets, issues, fixAttempts, reviewResults } from "../db/schema.js";

const TARGET_REPO_PATH = process.env.TARGET_REPO_PATH ?? "";

/**
 * Builds the prompt handed to the Claude Agent SDK session: the ticket's
 * concrete findings (rule, selector, page — not the whole codebase), retry
 * context from prior rejected attempts, and repo conventions if a CLAUDE.md
 * exists. See the architecture doc §02 "How the Developer agent gets code
 * context" — it explores the repo itself via Read/Grep/Glob, it doesn't need
 * the code pre-loaded here.
 */
export async function buildPrompt(ticketId: string): Promise<string> {
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);

  const ticketIssues = await db
    .select()
    .from(issues)
    .where(inArray(issues.id, ticket.issueIds as string[]));

  const priorAttempts = await db
    .select()
    .from(fixAttempts)
    .where(eq(fixAttempts.ticketId, ticketId))
    .orderBy(desc(fixAttempts.attemptNumber));

  const priorFeedback: string[] = [];
  for (const attempt of priorAttempts) {
    const [review] = await db
      .select()
      .from(reviewResults)
      .where(eq(reviewResults.fixAttemptId, attempt.id));
    if (review && review.verdict === "rejected") {
      priorFeedback.push(`Attempt ${attempt.attemptNumber} was rejected: ${review.comments}`);
    }
  }

  const conventionsPath = join(TARGET_REPO_PATH, "CLAUDE.md");
  const conventions = existsSync(conventionsPath) ? readFileSync(conventionsPath, "utf-8") : "";

  const findings = ticketIssues
    .map((i) => `- ${i.wcagRule} at "${i.selector}" on ${i.pageUrl} (severity: ${i.severity})`)
    .join("\n");

  console.log(`[prompt-builder] Ticket ${ticketId} (${ticket.jiraKey ?? "no-jira-key"}) category="${ticket.category}"`);
  console.log(`[prompt-builder]   issueIds in ticket: ${(ticket.issueIds as string[]).length}, issues found in DB: ${ticketIssues.length}`);
  if (ticketIssues.length === 0) {
    console.warn(`[prompt-builder]   ⚠ No issues resolved from issueIds — the SDK agent will have no findings to act on.`);
    console.warn(`[prompt-builder]   issueIds: ${JSON.stringify(ticket.issueIds)}`);
  } else {
    for (const i of ticketIssues) {
      console.log(`[prompt-builder]   - ${i.wcagRule} | "${i.selector}" | ${i.pageUrl} (${i.severity})`);
    }
  }
  if (priorFeedback.length > 0) {
    console.log(`[prompt-builder]   Prior rejected attempts: ${priorFeedback.length}`);
  }

  return [
    `You are fixing an accessibility issue category: "${ticket.category}".`,
    `Findings from the automated scan (WCAG rule, DOM selector, page):`,
    findings,
    priorFeedback.length
      ? `\nPrior attempts on this ticket were rejected — do not repeat these mistakes:\n${priorFeedback.join("\n")}`
      : "",
    conventions ? `\nRepo conventions (CLAUDE.md):\n${conventions}` : "",
    `\nFix every instance listed above. Make the smallest change that resolves the issue —`,
    `don't refactor unrelated code. Run the existing test suite before finishing.`,
  ]
    .filter(Boolean)
    .join("\n");
}
