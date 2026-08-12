import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { tickets, issues, fixAttempts, reviewResults } from "../db/schema.js";
const TARGET_REPO_PATH = process.env.TARGET_REPO_PATH ?? "";
const REPORT_DIR = process.env.A11Y_REPORT_DIR ?? join(process.cwd(), "a11y-reports");

/**
 * Static, ticket-independent instructions handed to the Claude Agent SDK
 * session as its systemPrompt: worktree-safety rules, repo conventions
 * (CLAUDE.md, if present), and the fix/build/verification steps. This text
 * is byte-identical across every ticket, retry, and autofix call in a run,
 * so putting it in systemPrompt (rather than concatenating it into the
 * per-ticket prompt) lets the SDK/API cache it instead of re-billing it
 * on every call.
 */
export function buildSystemPrompt(): string {
  const conventionsPath = join(TARGET_REPO_PATH, "CLAUDE.md");
  const conventions = existsSync(conventionsPath) ? readFileSync(conventionsPath, "utf-8") : "";

  return [
    `CRITICAL: You are working inside a git worktree. ALL file reads and edits MUST stay within your current working directory.`,
    `- Do NOT navigate to, read from, or edit files in any other directory on the filesystem.`,
    `- Do NOT follow localhost URLs to discover source paths outside your working directory.`,
    `- The page URLs given in findings are for context only — find the corresponding source files by searching within your current working directory using Grep and Glob.`,
    `- If you cannot find a file in your working directory, it may not exist on this branch. Do NOT look for it elsewhere.`,
    conventions ? `\nRepo conventions (CLAUDE.md):\n${conventions}` : "",
    `\nFix every instance listed in the findings you're given. Make the smallest change that resolves the issue —`,
    `don't refactor unrelated code.`,
    ``,
    `BUILD VALIDATION (MANDATORY — do this BEFORE finishing):`,
    `1. Run the project's build command (e.g. "npm run build" or "npx tsc --noEmit") in your working directory.`,
    `2. If the build fails, fix ALL errors — especially unused imports (TS6133), type errors, and syntax errors.`,
    `3. When you remove or replace an import's usage, ALWAYS check whether the import itself is now unused and remove it.`,
    `4. Run the build again to confirm it passes. Do NOT finish with a broken build.`,
    ``,
    `VERIFICATION: After making your changes, use Grep to confirm that the problematic patterns`,
    `(missing attributes, incorrect HTML) are no longer present in the files you edited.`,
    `If the selector references a component, search for all instances of that component to fix them all.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Per-ticket, variable content: the concrete findings (rule, selector, page —
 * not the whole codebase) and retry context from prior rejected attempts.
 * See the architecture doc §02 "How the Developer agent gets code context" —
 * it explores the repo itself via Read/Grep/Glob, it doesn't need the code
 * pre-loaded here.
 */
export async function buildUserPrompt(ticketId: string): Promise<string> {
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

  // Enrich findings with HTML snippets and fix suggestions from the scan reports
  // so the SDK agent knows exactly what DOM element to target in source code.
  const reportData = loadReportDataForIssues(ticketIssues);

  const findings = ticketIssues
    .map((i) => {
      const pageRoute = i.pageUrl.replace(/^https?:\/\/[^/]+/, "") || "/";
      const enrichment = reportData.get(`${i.wcagRule}::${i.selector}::${i.pageUrl}`);
      const lines = [`- ${i.wcagRule} at "${i.selector}" on route ${pageRoute} (severity: ${i.severity})`];
      if (enrichment) {
        if (enrichment.html) lines.push(`  HTML: ${enrichment.html}`);
        if (enrichment.failureSummary) lines.push(`  Fix: ${enrichment.failureSummary}`);
      }
      return lines.join("\n");
    })
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
    ``,
    `Findings from the automated scan (WCAG rule, DOM selector, page):`,
    findings,
    priorFeedback.length
      ? `\nPrior attempts on this ticket were rejected — do not repeat these mistakes:\n${priorFeedback.join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function loadReportDataForIssues(
  ticketIssues: Array<{ wcagRule: string; selector: string; pageUrl: string }>,
): Map<string, { html: string; failureSummary: string | null }> {
  const result = new Map<string, { html: string; failureSummary: string | null }>();
  try {
    if (!existsSync(REPORT_DIR)) return result;
    const files = readdirSync(REPORT_DIR).filter((f) => f.endsWith(".json"));
    const pages = files.map((file) => {
      const raw = JSON.parse(readFileSync(join(REPORT_DIR, file), "utf-8"));
      return { url: raw.url, violations: raw.violations ?? [] };
    });
    for (const page of pages) {
      for (const violation of page.violations) {
        for (const node of violation.nodes) {
          const selector = node.target.join(" ");
          const key = `${violation.id}::${selector}::${page.url}`;
          if (!result.has(key)) {
            result.set(key, {
              html: truncateStr(node.html, 300),
              failureSummary: node.failureSummary,
            });
          }
        }
      }
    }
  } catch {
    // Non-critical — the prompt still works without enrichment
  }
  return result;
}

function truncateStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}
