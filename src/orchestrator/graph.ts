/**
 * LangGraph orchestrator — implements the pipeline:
 *
 *   scan (Playwright + axe) -> triage (from reports) -> [open tickets?]
 *     yes -> fan out one branch per ticket: developer -> reviewer ->
 *            (rejected, attempt<2 -> back to developer)
 *            (rejected twice -> park, handled inside reviewer agent, branch ends)
 *            (approved, scope-flagged -> flag, handled inside reviewer agent, branch ends)
 *            (approved, clean -> deploy, branch ends)
 *     -> loop back to scan
 *     no  -> release (single human checkpoint)
 */
import "dotenv/config";
import { StateGraph, Annotation, Send, START, END } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { db } from "../db/client.js";
import { tickets, iterationCycles } from "../db/schema.js";
import { inArray, eq, and } from "drizzle-orm";
import { triageFromReports } from "../triage/triage-from-reports.js";
import { runDeveloperAgent } from "../development/developer-agent.js";
import { runReviewerAgent } from "../review/reviewer-agent.js";
import { runDeployAgent } from "../deploy/deploy-agent.js";
import { runReleaseAgent } from "../release/release-agent.js";
import { ensureEpic } from "../integrations/jira.js";
import { withSpan } from "../integrations/observability.js";
import { run } from "../lib/exec.js";
import { traceable } from "langsmith/traceable";
import path from "node:path";

const MAX_CYCLES = 20;
const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");

const CycleState = Annotation.Root({
  cycleId: Annotation<string>,
  cycleNumber: Annotation<number>,
  epicKey: Annotation<string | null>,
  ticketId: Annotation<string | null>,
});

const TicketState = Annotation.Root({
  ticketId: Annotation<string>,
  epicKey: Annotation<string | null>,
});

async function scanNode(state: typeof CycleState.State) {
  return withSpan("scan.playwright", async () => {
    console.log("[orchestrate] Running Playwright + axe scan...");
    try {
      await run("npx", ["playwright", "test"], PROJECT_ROOT);
    } catch (err) {
      console.warn("[orchestrate] Some Playwright tests may have failed — continuing with available reports.", (err as Error).message.slice(0, 300));
    }
    try {
      await run("node", ["src/scan/scripts/generate-a11y-report.mjs"], PROJECT_ROOT);
    } catch (err) {
      console.warn("[orchestrate] Report generation had issues:", (err as Error).message.slice(0, 300));
    }
    console.log("[orchestrate] Scan complete.");
    return {};
  });
}

async function triageNode(state: typeof CycleState.State) {
  return withSpan("agent.triage", async () => {
    console.log("[orchestrate] Running triage from reports...");
    const epicKey = state.epicKey ?? (await ensureEpic(state.cycleId));
    const result = await triageFromReports({ cycleId: state.cycleId });
    console.log(`[orchestrate] Triage complete: ${result.dbSync.ticketsCreated} ticket(s) created, ${result.summary.totalViolationTypes} violation type(s).`);
    return { epicKey };
  });
}

async function routeAfterTriage(state: typeof CycleState.State) {
  const epicKey = state.epicKey;
  const openTickets = epicKey
    ? await db.select().from(tickets).where(and(eq(tickets.status, "open"), eq(tickets.epicKey, epicKey)))
    : await db.select().from(tickets).where(eq(tickets.status, "open"));
  if (openTickets.length === 0 || state.cycleNumber >= MAX_CYCLES) {
    console.log(`[orchestrate] ${openTickets.length === 0 ? "No open tickets" : "Max cycles reached"} — moving to release.`);
    return "release";
  }
  console.log(`[orchestrate] ${openTickets.length} open ticket(s) — fanning out to developer agent.`);
  return openTickets.map((t) => new Send("developer", { ticketId: t.id, epicKey: state.epicKey }));
}

async function developerNode(state: typeof TicketState.State) {
  return withSpan("agent.developer", async () => {
    console.log(`[orchestrate] Running developer agent on ticket ${state.ticketId}...`);
    const { fixAttemptId } = await runDeveloperAgent(state.ticketId);
    console.log(`[orchestrate] Developer done — fix attempt ${fixAttemptId}.`);
    return { fixAttemptId } as any;
  });
}

async function reviewerNode(state: typeof TicketState.State & { fixAttemptId: string }) {
  return withSpan("agent.reviewer", async () => {
    console.log(`[orchestrate] Running reviewer on fix attempt ${state.fixAttemptId}...`);
    const verdict = await runReviewerAgent(state.fixAttemptId);
    console.log(`[orchestrate] Reviewer verdict: ${verdict.verdict}${verdict.scopeGuardFlagged ? " (scope-flagged)" : ""}.`);
    return { verdict } as any;
  });
}

async function routeAfterReview(state: any) {
  if (state.verdict.verdict === "rejected") {
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, state.ticketId));
    if (ticket?.status === "open") return "developer";
    return END;
  }
  if (state.verdict.scopeGuardFlagged) return END;
  if (!state.fixAttemptId) {
    console.log(`[orchestrate] No fix attempt to deploy — skipping deploy.`);
    return END;
  }
  return "deploy";
}

export function buildGraph() {
  const graph = new StateGraph(CycleState)
    .addNode("scan", scanNode)
    .addNode("triage", triageNode)
    .addNode("developer", developerNode as any)
    .addNode("reviewer", reviewerNode as any)
    .addNode("deploy", async (state: any) =>
      withSpan("agent.deploy", async () => {
        console.log(`[orchestrate] Running deploy on fix attempt ${state.fixAttemptId}...`);
        await runDeployAgent(state.fixAttemptId);
        console.log(`[orchestrate] Deploy complete.`);
        return {};
      }),
    )
    .addNode("release", async (state: typeof CycleState.State) =>
      withSpan("agent.release", async () => {
        console.log(`[orchestrate] Running release for cycle ${state.cycleId}...`);
        await db.update(iterationCycles).set({ endedAt: new Date() }).where(eq(iterationCycles.id, state.cycleId));
        await runReleaseAgent(state.cycleId);
        console.log(`[orchestrate] Release complete.`);
        return {};
      }),
    )
    .addEdge(START, "scan")
    .addEdge("scan", "triage")
    .addConditionalEdges("triage", routeAfterTriage, ["developer", "release"])
    .addEdge("developer", "reviewer")
    .addConditionalEdges("reviewer", routeAfterReview, ["developer", "deploy", END])
    .addEdge("deploy", "scan")
    .addEdge("release", END);

  return graph;
}

export const runOrchestratorCycle = traceable(_runOrchestratorCycle, { name: "orchestrator-cycle", run_type: "chain" });

async function _runOrchestratorCycle() {
  const { initObservability } = await import("../integrations/observability.js");
  await initObservability();

  const checkpointer = PostgresSaver.fromConnString(process.env.DATABASE_URL!);
  await checkpointer.setup();

  const compiled = buildGraph().compile({ checkpointer });

  const [cycle] = await db
    .insert(iterationCycles)
    .values({ cycleNumber: 0, openIssueCount: 0 })
    .returning();

  console.log(`[orchestrate] Starting pipeline — cycle ${cycle.id}`);
  console.log(`[orchestrate] Flow: scan → triage → developer → reviewer → deploy → release`);

  await compiled.invoke(
    { cycleId: cycle.id, cycleNumber: 0, epicKey: null, ticketId: null },
    { configurable: { thread_id: cycle.id } },
  );
}
