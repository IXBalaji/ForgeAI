#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { runScannerAgent, type AuthRole } from "../scan/scanner-agent.js";
import { runTriageAgent } from "../triage/triage-agent.js";
import { triageFromReports } from "../triage/triage-from-reports.js";
import { runDeveloperAgent, type DeveloperResult } from "../development/developer-agent.js";
import { runReviewerAgent, type ReviewerVerdict } from "../review/reviewer-agent.js";
import { runDeployAgent, type DeployResult } from "../deploy/deploy-agent.js";
import { runReleaseAgent } from "../release/release-agent.js";
import { ensureEpic } from "../integrations/jira.js";
import { runOrchestratorCycle } from "../orchestrator/graph.js";
import { initObservability, withSpan } from "../integrations/observability.js";
import { db } from "../db/client.js";
import { iterationCycles } from "../db/schema.js";

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
    const epicKey = await ensureEpic(cycleId);
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
  .description("Run the developer agent on all open tickets in the local DB")
  .option("--limit <n>", "max tickets to process", "10")
  .action(async (opts) => {
    const { inArray } = await import("drizzle-orm");
    const { tickets } = await import("../db/schema.js");
    const openTickets = await db
      .select()
      .from(tickets)
      .where(inArray(tickets.status, ["open"]))
      .limit(parseInt(opts.limit));

    if (openTickets.length === 0) {
      console.log("[fix:all] No open tickets found in local DB");
      return;
    }

    const maxRetries = 2;
    console.log(`[fix:all] Found ${openTickets.length} open ticket(s)`);
    for (const ticket of openTickets) {
      console.log(`\n[fix:all] ── Ticket ${ticket.id} (${ticket.jiraKey ?? "no jira key"}) ──`);

      // Stage 1: Developer agent
      let devResult: DeveloperResult | null = null;
      let succeeded = false;
      for (let retry = 0; retry <= maxRetries && !succeeded; retry++) {
        try {
          if (retry > 0) console.log(`[fix:all] Retrying developer agent (attempt ${retry + 1}/${maxRetries + 1})`);
          devResult = await withSpan("agent.developer", () => runDeveloperAgent(ticket.id));
          console.log(`[fix:all] Developer done:`, JSON.stringify(devResult, null, 2));
          succeeded = true;
        } catch (err) {
          console.error(`[fix:all] Developer failed: ${(err as Error).message}`);
          if (retry < maxRetries) {
            const delay = Math.min(2000 * 2 ** retry, 15000);
            console.log(`[fix:all] Waiting ${delay / 1000}s before retry...`);
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }
      if (!succeeded || !devResult) {
        console.error(`[fix:all] Gave up on ticket ${ticket.id} after ${maxRetries + 1} developer attempts`);
        continue;
      }
      if (!devResult.fixAttemptId) {
        console.warn(`[fix:all] Developer produced no commit for ticket ${ticket.id} — skipping review/deploy.`);
        continue;
      }
      const fixAttemptId = devResult.fixAttemptId;

      // Stage 2: Reviewer agent
      let reviewResult: ReviewerVerdict | null = null;
      try {
        console.log(`[fix:all] Running reviewer on fix attempt ${fixAttemptId}...`);
        reviewResult = await withSpan("agent.reviewer", () => runReviewerAgent(fixAttemptId));
        console.log(`[fix:all] Reviewer verdict:`, JSON.stringify(reviewResult, null, 2));
      } catch (err) {
        console.error(`[fix:all] Reviewer failed: ${(err as Error).message}`);
        continue;
      }

      if (reviewResult.verdict !== "approved") {
        console.log(`[fix:all] Reviewer rejected — skipping deploy for ticket ${ticket.id}`);
        continue;
      }
      if (reviewResult.scopeGuardFlagged) {
        console.log(`[fix:all] Scope guard flagged — holding ticket ${ticket.id} for manual review`);
        continue;
      }

      // Stage 3: Deploy agent (merge PR + tag)
      try {
        console.log(`[fix:all] Running deploy on fix attempt ${fixAttemptId}...`);
        const deployResult: DeployResult = await withSpan("agent.deploy", () => runDeployAgent(fixAttemptId));
        console.log(`[fix:all] Deploy done:`, JSON.stringify(deployResult, null, 2));
      } catch (err) {
        console.error(`[fix:all] Deploy failed: ${(err as Error).message}`);
      }
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
  .command("orchestrate")
  .description("Run the full autonomous LangGraph cycle: scan -> triage:reports -> sync:jira -> fix -> review -> deploy -> loop -> release")
  .action(async () => {
    await runOrchestratorCycle();
  });

program.parseAsync(process.argv);
