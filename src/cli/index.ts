#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { runScannerAgent, type AuthRole } from "../scan/scanner-agent.js";
import { runTriageAgent } from "../triage/triage-agent.js";
import { triageFromReports } from "../triage/triage-from-reports.js";
import { runDeveloperAgent, fixTicketOnBranch, type DeveloperResult, type BatchFixResult } from "../development/developer-agent.js";
import { runReviewerAgent, reviewBranch, type ReviewerVerdict, type BranchReviewVerdict } from "../review/reviewer-agent.js";
import { runDeployAgent, deployBranch, type DeployResult, type BranchDeployResult } from "../deploy/deploy-agent.js";
import { runReleaseAgent } from "../release/release-agent.js";
import { getTrackerProvider } from "../integrations/tracker/factory.js";
import { runOrchestratorCycle } from "../orchestrator/graph.js";
import { initObservability, withSpan } from "../integrations/observability.js";
import { db } from "../db/client.js";
import { iterationCycles } from "../db/schema.js";

const tracker = getTrackerProvider();

const program = new Command();
program.name("a11y-agents").description("Autonomous accessibility remediation agent system");

// Every subcommand below calls the exact same function the LangGraph orchestrator
// calls — this is what "any agent runs independently" means in practice (§01/§02
// of the architecture doc): the graph is a convenience, not a dependency.

program.hook("preAction", async () => {
  await initObservability();
});

function parseAuthRolesEnv(): AuthRole[] | undefined {
  const raw = process.env.TARGET_AUTH_ROLES;
  if (!raw) return undefined;
  return raw.split(",").map((entry) => {
    const [label, email, password, routesPart] = entry.split(":");
    return {
      label,
      credentials: { email, password },
      routes: routesPart ? routesPart.split(";") : [],
    };
  });
}

program
  .command("scan")
  .description("Run the Scanner agent against the target app, no ticket creation")
  .option("--env <env>", "target environment label", "adhoc")
  .action(async (opts) => {
    const roles = parseAuthRolesEnv();
    const loginUrl = process.env.TARGET_LOGIN_URL;
    const result = await withSpan("agent.scanner", () =>
      runScannerAgent({
        targetEnv: opts.env,
        baseUrl: process.env.TARGET_FRONTEND_URL ?? "http://localhost:5173",
        routes: (process.env.TARGET_SCAN_ROUTES ?? "/").split(","),
        triggeredBy: "cli",
        auth: roles ? { loginUrl, roles } : undefined,
      }),
    );
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("triage")
  .description("Run the Triage agent against a completed scan run")
  .requiredOption("--scan-run <id>", "scan run id to triage")
  .option("--cycle <id>", "iteration cycle id to file the epic under (creates a throwaway one if omitted)")
  .action(async (opts) => {
    const cycleId = opts.cycle ?? (await db.insert(iterationCycles).values({ cycleNumber: 0 }).returning())[0].id;
    const epicKey = await tracker.ensureEpic(cycleId);
    const result = await withSpan("agent.triage", () => runTriageAgent(opts.scanRun, epicKey));
    console.log(JSON.stringify({ cycleId, ...result }, null, 2));
  });

program
  .command("triage:reports")
  .description("Triage accessibility violations from a11y-report JSON files into Jira tickets")
  .option("--report-dir <dir>", "directory containing axe JSON reports", "a11y-reports")
  .option("--cycle <id>", "iteration cycle id for epic grouping")
  .option("--dry-run", "classify and build tickets without creating them in Jira")
  .action(async (opts) => {
    const result = await withSpan("agent.triage-reports", () =>
      triageFromReports({
        reportDir: opts.reportDir,
        cycleId: opts.cycle,
        dryRun: opts.dryRun,
      }),
    );
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("fix")
  .description("Run the Developer agent against one ticket")
  .requiredOption("--ticket <id>", "ticket id")
  .action(async (opts) => {
    const result = await withSpan("agent.developer", () => runDeveloperAgent(opts.ticket));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("review")
  .description("Run the Reviewer agent against one fix attempt")
  .requiredOption("--attempt <id>", "fix attempt id")
  .action(async (opts) => {
    const result = await withSpan("agent.reviewer", () => runReviewerAgent(opts.attempt));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("deploy")
  .description("Run the Deploy agent against one fix attempt")
  .requiredOption("--attempt <id>", "fix attempt id")
  .action(async (opts) => {
    const result = await withSpan("agent.deploy", () => runDeployAgent(opts.attempt));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("resolve-conflicts")
  .description("Run the conflict resolver against one fix attempt — pulls QA, resolves conflicts with AI, pushes back")
  .requiredOption("--attempt <id>", "fix attempt id")
  .action(async (opts) => {
    const { resolveConflicts } = await import("../deploy/conflict-resolver.js");
    const result = await withSpan("agent.conflict-resolver", () => resolveConflicts(opts.attempt));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("release")
  .description("Run the Release agent — open the single end-of-cycle PR + report")
  .requiredOption("--cycle <id>", "iteration cycle id")
  .action(async (opts) => {
    const result = await withSpan("agent.release", () => runReleaseAgent(opts.cycle));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("sync:jira")
  .description("Sync open accessibility tickets from Jira into the local DB for the fix pipeline")
  .option("--jql <jql>", "custom JQL query override")
  .option("--max <n>", "max tickets to sync", "50")
  .action(async (opts) => {
    const { syncJiraTickets } = await import("../triage/jira-scanner.js");
    const result = await withSpan("sync.jira", () =>
      syncJiraTickets({
        jql: opts.jql,
        maxResults: parseInt(opts.max),
      }),
    );
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("fix:all")
  .description("Fix all open tickets on a single branch, review once, deploy once")
  .option("--limit <n>", "max tickets to process", "10")
  .action(async (opts) => {
    const { inArray } = await import("drizzle-orm");
    const { join } = await import("node:path");
    const { tickets, issues } = await import("../db/schema.js");
    const { gitRepoMutex } = await import("../lib/mutex.js");
    const { LABEL_PREFIX_SLUG } = await import("../lib/config.js");
    const { run } = await import("../lib/exec.js");

    const TARGET_REPO_PATH = process.env.TARGET_REPO_PATH ?? "";
    const QA_BRANCH = process.env.GITHUB_QA_BRANCH ?? "qa";
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
    const GITHUB_OWNER = process.env.GITHUB_OWNER ?? "";
    const GITHUB_REPO = process.env.GITHUB_REPO ?? "";

    const openTickets = await db
      .select()
      .from(tickets)
      .where(inArray(tickets.status, ["open"]))
      .limit(parseInt(opts.limit));

    if (openTickets.length === 0) {
      console.log("[fix:all] No open tickets found in local DB");
      return;
    }

    console.log(`[fix:all] Found ${openTickets.length} open ticket(s) — creating single branch\n`);

    // Log ticket details
    for (const ticket of openTickets) {
      const issueIds = (ticket.issueIds as string[]) ?? [];
      const resolvedIssues = issueIds.length > 0
        ? await db.select().from(issues).where(inArray(issues.id, issueIds))
        : [];
      console.log(`[fix:all] ── Ticket ${ticket.id} (${ticket.jiraKey ?? "no jira key"}) ──`);
      console.log(`[fix:all]   category: ${ticket.category}`);
      console.log(`[fix:all]   issueIds: ${issueIds.length} stored, ${resolvedIssues.length} found in DB`);
    }

    // Stage 1: Create a single branch
    const jiraKeys = openTickets.map((t) => t.jiraKey).filter(Boolean);
    const branchLabel = jiraKeys.length > 0 ? jiraKeys.join("-") : openTickets[0].id.slice(0, 8);
    const branch = `${LABEL_PREFIX_SLUG}/batch-${branchLabel}-${Date.now()}`;
    const worktreeDir = join(TARGET_REPO_PATH, "..", ".worktrees", branch.replace(/\//g, "-"));

    let releaseLock = await gitRepoMutex.acquire();
    try {
      await run("git", ["fetch", "origin", QA_BRANCH], TARGET_REPO_PATH);
      await run("git", ["worktree", "add", "-b", branch, worktreeDir, `origin/${QA_BRANCH}`], TARGET_REPO_PATH);
    } finally {
      releaseLock();
    }
    console.log(`[fix:all] Branch: ${branch}\n`);

    // Stage 2: Fix each ticket on the shared branch
    const fixedTicketIds: string[] = [];
    for (let i = 0; i < openTickets.length; i++) {
      const ticket = openTickets[i];
      console.log(`\n[fix:all] ── Fixing ticket ${i + 1}/${openTickets.length}: ${ticket.jiraKey ?? ticket.id.slice(0, 8)} ──`);
      try {
        const result: BatchFixResult = await withSpan("agent.developer", () => fixTicketOnBranch(ticket.id, worktreeDir));
        if (result.commitSha) {
          fixedTicketIds.push(ticket.id);
          console.log(`[fix:all] ✓ Committed: ${result.commitSha.slice(0, 7)}`);
        } else {
          console.warn(`[fix:all] ✗ No changes produced`);
        }
      } catch (err) {
        console.error(`[fix:all] Developer failed for ${ticket.jiraKey ?? ticket.id.slice(0, 8)}: ${(err as Error).message}`);
      }
    }

    if (fixedTicketIds.length === 0) {
      console.log("\n[fix:all] No tickets produced commits — cleaning up.");
      releaseLock = await gitRepoMutex.acquire();
      try { await run("git", ["worktree", "remove", "--force", worktreeDir], TARGET_REPO_PATH); } catch {} finally { releaseLock(); }
      return;
    }

    // Stage 3: Push the branch
    releaseLock = await gitRepoMutex.acquire();
    try {
      if (GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO) {
        const authRemote = `https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git`;
        await run("git", ["remote", "set-url", "origin", authRemote], worktreeDir);
      }
      await run("git", ["-c", "credential.helper=", "push", "-u", "origin", branch], worktreeDir);
      console.log(`\n[fix:all] Pushed branch with ${fixedTicketIds.length} fix commit(s).`);
    } finally {
      releaseLock();
    }

    // Stage 4: Review entire branch
    console.log(`\n[fix:all] Running reviewer on entire branch...`);
    let branchReview: BranchReviewVerdict;
    try {
      branchReview = await withSpan("agent.reviewer", () => reviewBranch(worktreeDir, fixedTicketIds));
      console.log(`[fix:all] Reviewer verdict: ${branchReview.verdict}`);
    } catch (err) {
      console.error(`[fix:all] Reviewer failed: ${(err as Error).message}`);
      releaseLock = await gitRepoMutex.acquire();
      try { await run("git", ["worktree", "remove", "--force", worktreeDir], TARGET_REPO_PATH); } catch {} finally { releaseLock(); }
      return;
    }

    // Cleanup worktree (review is done, deploy uses GitHub API)
    releaseLock = await gitRepoMutex.acquire();
    try { await run("git", ["worktree", "remove", "--force", worktreeDir], TARGET_REPO_PATH); } catch {} finally { releaseLock(); }

    if (branchReview.verdict !== "approved") {
      console.log(`[fix:all] Reviewer rejected — all ${fixedTicketIds.length} ticket(s) remain open.`);
      return;
    }

    // Stage 5: Deploy — merge the single branch
    console.log(`\n[fix:all] Deploying branch ${branch}...`);
    try {
      const result: BranchDeployResult = await withSpan("agent.deploy", () => deployBranch(branch, fixedTicketIds));
      console.log(`[fix:all] Deploy done:`, JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`[fix:all] Deploy failed: ${(err as Error).message}`);
    }
  });

program
  .command("review:deploy")
  .description("Re-review all existing fix attempts that have PRs and deploy approved ones (skips developer agent)")
  .option("--limit <n>", "max attempts to process", "10")
  .action(async (opts) => {
    const { eq, isNotNull, sql } = await import("drizzle-orm");
    const { fixAttempts, tickets } = await import("../db/schema.js");
    const attempts = await db
      .select()
      .from(fixAttempts)
      .where(isNotNull(fixAttempts.prUrl))
      .limit(parseInt(opts.limit));

    if (attempts.length === 0) {
      console.log("[review:deploy] No fix attempts with PRs found");
      return;
    }

    console.log(`[review:deploy] Found ${attempts.length} fix attempt(s) with PRs`);
    for (const attempt of attempts) {
      console.log(`\n[review:deploy] ── Attempt ${attempt.id} (branch: ${attempt.branch}) ──`);

      // Stage 1: Reviewer
      let reviewResult: ReviewerVerdict | null = null;
      try {
        console.log(`[review:deploy] Running reviewer...`);
        reviewResult = await withSpan("agent.reviewer", () => runReviewerAgent(attempt.id));
        console.log(`[review:deploy] Reviewer verdict:`, JSON.stringify(reviewResult, null, 2));
      } catch (err) {
        console.error(`[review:deploy] Reviewer failed: ${(err as Error).message}`);
        continue;
      }

      if (reviewResult.verdict !== "approved") {
        console.log(`[review:deploy] Reviewer rejected — skipping deploy`);
        continue;
      }
      if (reviewResult.scopeGuardFlagged) {
        console.log(`[review:deploy] Scope guard flagged — holding for manual review`);
        continue;
      }

      // Stage 2: Deploy
      try {
        console.log(`[review:deploy] Running deploy...`);
        const deployResult: DeployResult = await withSpan("agent.deploy", () => runDeployAgent(attempt.id));
        console.log(`[review:deploy] Deploy done:`, JSON.stringify(deployResult, null, 2));
      } catch (err) {
        console.error(`[review:deploy] Deploy failed: ${(err as Error).message}`);
      }
    }
  });

program
  .command("scan:rules")
  .description("List WCAG 2.2 criteria and their axe-core rules, showing which are attached/detached")
  .option("--level <level>", "filter by WCAG level (A or AA)", "AA")
  .option("--owner <owner>", "filter by owner (UX/UI, Frontend, Shared)")
  .option("--detached", "show only detached criteria")
  .action(async (opts) => {
    const { WCAG_REGISTRY } = await import("../scan/wcag-rules.js");
    const { resolveAxeConfig } = await import("../scan/scan-config.js");
    const resolved = resolveAxeConfig();

    let criteria = WCAG_REGISTRY;
    if (opts.level === "A") criteria = criteria.filter((c) => c.level === "A");
    if (opts.owner) criteria = criteria.filter((c) => c.owner === opts.owner || c.owner === "Shared");
    if (opts.detached) criteria = criteria.filter((c) => !c.enabled);

    console.log(`\nWCAG 2.2 Level ${opts.level} — ${criteria.length} criteria\n`);
    console.log("Status   | WCAG   | Level | Owner    | Name                                    | Axe Rules");
    console.log("-".repeat(120));
    for (const c of criteria) {
      const status = c.enabled ? "ATTACHED" : "DETACHED";
      const rules = c.axeRules.length > 0 ? c.axeRules.join(", ") : "(manual only)";
      console.log(
        `${status.padEnd(8)} | ${c.id.padEnd(6)} | ${c.level.padEnd(5)} | ${c.owner.padEnd(8)} | ${c.name.padEnd(39)} | ${rules}`,
      );
    }
    console.log(`\n${resolved.enabledRules.length} axe rules active, ${resolved.disabledRules.length} disabled\n`);
  });

program
  .command("cost-report")
  .description("Show AI token usage and cost breakdown from LangSmith traces")
  .option("--days <n>", "lookback period in days", "7")
  .option("--project <name>", "LangSmith project name (defaults to LANGSMITH_PROJECT env var)")
  .action(async (opts) => {
    const { generateCostReport } = await import("../observability/cost-report.js");
    await generateCostReport({
      days: parseInt(opts.days),
      project: opts.project,
    });
  });

program
  .command("orchestrate")
  .description("Run the full autonomous LangGraph cycle: scan -> triage -> fix (one ticket at a time) -> review -> deploy -> next ticket -> release")
  .action(async () => {
    await runOrchestratorCycle();
  });

program.parseAsync(process.argv);
