/**
 * LangGraph orchestrator — implements the flowchart in the architecture doc §01:
 *
 *   scan -> triage -> [auto-retriable tickets open?]
 *     yes -> fan out one branch per ticket: developer -> reviewer ->
 *            (rejected, attempt<2 -> back to developer)
 *            (rejected twice -> park, handled inside reviewer agent, branch ends)
 *            (approved, scope-flagged -> flag, handled inside reviewer agent, branch ends)
 *            (approved, clean -> deploy, branch ends)
 *     -> loop back to scan
 *     no  -> release (single human checkpoint)
 *
 * IMPORTANT: verify the exact @langchain/langgraph API below (Annotation, Send,
 * addConditionalEdges signatures) against the current LangGraph.js docs before
 * running — this file was written from general knowledge of the library, not
 * from its live reference, and the JS API has moved across versions.
 */
import "dotenv/config";
import { StateGraph, Annotation, Send, START, END } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { db } from "../db/client.js";
import { tickets, iterationCycles } from "../db/schema.js";
import { inArray, eq } from "drizzle-orm";
import { runScannerAgent } from "../scan/scanner-agent.js";
import { runTriageAgent } from "../triage/triage-agent.js";
import { runDeveloperAgent } from "../development/developer-agent.js";
import { runReviewerAgent } from "../review/reviewer-agent.js";
import { runDeployAgent } from "../deploy/deploy-agent.js";
import { runReleaseAgent } from "../release/release-agent.js";
import { ensureEpic } from "../integrations/jira.js";
import { withSpan } from "../integrations/observability.js";

const MAX_CYCLES = 20; // circuit breaker on the outer loop itself

const CycleState = Annotation.Root({
  cycleId: Annotation<string>,
  cycleNumber: Annotation<number>,
  scanRunId: Annotation<string | null>,
  epicKey: Annotation<string | null>,
  ticketId: Annotation<string | null>, // set per-Send branch; null on the trunk
});

const TicketState = Annotation.Root({
  ticketId: Annotation<string>,
  epicKey: Annotation<string | null>,
});

async function scanNode(state: typeof CycleState.State) {
  return withSpan("agent.scanner", async () => {
    const { scanRunId } = await runScannerAgent({
      targetEnv: "qa",
      baseUrl: process.env.TARGET_FRONTEND_URL ?? "http://localhost:5173",
      routes: (process.env.TARGET_SCAN_ROUTES ?? "/").split(","),
      triggeredBy: "langgraph-orchestrator",
    });
    return { scanRunId };
  });
}

async function triageNode(state: typeof CycleState.State) {
  return withSpan("agent.triage", async () => {
    const epicKey = state.epicKey ?? (await ensureEpic(state.cycleId));
    await runTriageAgent(state.scanRunId!, epicKey);
    return { epicKey };
  });
}

/** Fan out to one Send-spawned branch per auto-retriable open ticket, or move to release. */
async function routeAfterTriage(state: typeof CycleState.State) {
  const openTickets = await db.select().from(tickets).where(inArray(tickets.status, ["open"]));
  if (openTickets.length === 0 || state.cycleNumber >= MAX_CYCLES) {
    return "release";
  }
  return openTickets.map((t) => new Send("developer", { ticketId: t.id, epicKey: state.epicKey }));
}

async function developerNode(state: typeof TicketState.State) {
  return withSpan("agent.developer", async () => {
    const { fixAttemptId } = await runDeveloperAgent(state.ticketId);
    return { fixAttemptId } as any;
  });
}

async function reviewerNode(state: typeof TicketState.State & { fixAttemptId: string }) {
  return withSpan("agent.reviewer", async () => {
    const verdict = await runReviewerAgent(state.fixAttemptId);
    return { verdict } as any;
  });
}

/** Reject-under-threshold retries; reject-at-threshold/approved-flagged/approved-clean all end this branch (the agents already recorded park/flag/done in Postgres). */
async function routeAfterReview(state: any) {
  if (state.verdict.verdict === "rejected") {
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, state.ticketId));
    if (ticket?.status === "open") return "developer"; // reviewer left it open -> retry
    return END; // reviewer parked it
  }
  if (state.verdict.scopeGuardFlagged) return END; // flagged, held out of merge
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
        await runDeployAgent(state.fixAttemptId);
        return {};
      }),
    )
    .addNode("release", async (state: typeof CycleState.State) =>
      withSpan("agent.release", async () => {
        await db.update(iterationCycles).set({ endedAt: new Date() }).where(eq(iterationCycles.id, state.cycleId));
        await runReleaseAgent(state.cycleId);
        return {};
      }),
    )
    .addEdge(START, "scan")
    .addEdge("scan", "triage")
    .addConditionalEdges("triage", routeAfterTriage, ["developer", "release"])
    .addEdge("developer", "reviewer")
    .addConditionalEdges("reviewer", routeAfterReview, ["developer", "deploy", END])
    .addEdge("deploy", "scan") // one resolved ticket re-triggers a re-scan of the whole loop
    .addEdge("release", END);

  return graph;
}

export async function runOrchestratorCycle() {
  const { initObservability } = await import("../integrations/observability.js");
  await initObservability();

  const checkpointer = PostgresSaver.fromConnString(process.env.DATABASE_URL!);
  await checkpointer.setup();

  const compiled = buildGraph().compile({ checkpointer });

  // The cycle row's own generated id IS the cycleId threaded through graph
  // state — previously this used a separately generated randomUUID() that
  // never matched the actual DB row, silently breaking epic reuse and the
  // release node's cycle-close update.
  const [cycle] = await db
    .insert(iterationCycles)
    .values({ cycleNumber: 0, openIssueCount: 0 })
    .returning();

  await compiled.invoke(
    { cycleId: cycle.id, cycleNumber: 0, scanRunId: null, epicKey: null, ticketId: null },
    { configurable: { thread_id: cycle.id } },
  );
}
