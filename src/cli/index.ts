#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { runScannerAgent } from "../scan/scanner-agent.js";
import { runTriageAgent } from "../triage/triage-agent.js";
import { runDeveloperAgent } from "../development/developer-agent.js";
import { runReviewerAgent } from "../review/reviewer-agent.js";
import { runDeployAgent } from "../deploy/deploy-agent.js";
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

program
  .command("scan")
  .description("Run the Scanner agent against the target app, no ticket creation")
  .option("--env <env>", "target environment label", "adhoc")
  .action(async (opts) => {
    const result = await withSpan("agent.scanner", () =>
      runScannerAgent({
        targetEnv: opts.env,
        baseUrl: process.env.TARGET_FRONTEND_URL ?? "http://localhost:5173",
        routes: (process.env.TARGET_SCAN_ROUTES ?? "/").split(","),
        triggeredBy: "cli",
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
  .command("orchestrate")
  .description("Run the full autonomous LangGraph cycle: scan -> triage -> fix -> review -> deploy -> loop -> release")
  .action(async () => {
    await runOrchestratorCycle();
  });

program.parseAsync(process.argv);
