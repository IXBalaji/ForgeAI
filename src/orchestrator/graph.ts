/**
 * LangGraph orchestrator — implements the flowchart in the architecture doc §01,
 * matching the manual pipeline (scan -> triage:reports -> sync:jira -> fix:all)
 * that this graph now runs as one real orchestrated flow instead of separate
 * shell commands:
 *
 *   scan -> triage:reports -> sync:jira -> [any open tickets?]
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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { StateGraph, Annotation, Send, START, END } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { db } from "../db/client.js";
import { tickets, iterationCycles } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { triageFromReports } from "../triage/triage-from-reports.js";
import { syncJiraTickets } from "../triage/jira-scanner.js";
import { runDeveloperAgent } from "../development/developer-agent.js";
import { runReviewerAgent } from "../review/reviewer-agent.js";
import { runDeployAgent } from "../deploy/deploy-agent.js";
import { runReleaseAgent } from "../release/release-agent.js";
import { withSpan } from "../integrations/observability.js";
import { traceable } from "langsmith/traceable";

const execFileAsync = promisify(execFile);
const MAX_DEVELOPER_RETRIES = 2; // mirrors the old fix:all CLI's per-ticket retry/backoff

const CycleState = Annotation.Root({
  cycleId: Annotation<string>,
  ticketId: Annotation<string | null>, // set per-Send branch; null on the trunk
});

const TicketState = Annotation.Root({
  ticketId: Annotation<string>,
});

async function scanNode(state: typeof CycleState.State) {
  return withSpan("agent.scanner", async () => {
    console.log("[orchestrator] Running Playwright accessibility scan...");
    await execFileAsync("npm", ["run", "scan"], { cwd: process.cwd(), shell: process.platform === "win32" });
    return {};
  });
}

async function triageNode(state: typeof CycleState.State) {
  return withSpan("agent.triage", async () => {
    const result = await triageFromReports({ cycleId: state.cycleId });
    console.log(
      `[orchestrator] Triage: ${result.dbSync.ticketsCreated} ticket(s) created from ${result.summary.totalViolationTypes} violation type(s)`,
    );
    return {};
  });
}

async function syncJiraNode(state: typeof CycleState.State) {
  return withSpan("sync.jira", async () => {
    const result = await syncJiraTickets({});
    console.log(`[orchestrator] Jira sync: ${result.synced} synced, ${result.skipped} skipped, ${result.errors.length} error(s)`);
    return {};
  });
}

/** Fan out to one Send-spawned branch per open ticket (matches fix:all's "all open tickets" scope), or move to release. */
async function routeAfterSync(state: typeof CycleState.State) {
  const openTickets = await db.select().from(tickets).where(eq(tickets.status, "open"));
  if (openTickets.length === 0) {
    return "release";
  }
  return openTickets.map((t) => new Send("developer", { ticketId: t.id }));
}

/** Retries transient failures (e.g. flaky Claude Agent SDK calls) so one bad ticket doesn't kill the whole cycle; leaves the ticket "open" on exhaustion so the next cycle picks it back up. */
async function developerNode(state: typeof TicketState.State) {
  return withSpan("agent.developer", async () => {
    for (let attempt = 0; attempt <= MAX_DEVELOPER_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`[orchestrator] Retrying ticket ${state.ticketId} (attempt ${attempt + 1}/${MAX_DEVELOPER_RETRIES + 1})`);
        }
        const { fixAttemptId } = await runDeveloperAgent(state.ticketId);
        return { fixAttemptId } as any;
      } catch (err) {
        console.error(`[orchestrator] Developer agent failed on ticket ${state.ticketId}: ${(err as Error).message}`);
        if (attempt < MAX_DEVELOPER_RETRIES) {
          const delay = Math.min(2000 * 2 ** attempt, 15000);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    console.error(`[orchestrator] Gave up on ticket ${state.ticketId} after ${MAX_DEVELOPER_RETRIES + 1} attempts`);
    return { fixAttemptId: null } as any;
  });
}

async function reviewerNode(state: typeof TicketState.State & { fixAttemptId: string | null }) {
  if (!state.fixAttemptId) return { verdict: null } as any; // developer gave up; ticket stays open for the next cycle
  return withSpan("agent.reviewer", async () => {
    const verdict = await runReviewerAgent(state.fixAttemptId!);
    return { verdict } as any;
  });
}

/** Reject-under-threshold retries; reject-at-threshold/approved-flagged/approved-clean all end this branch (the agents already recorded park/flag/done in Postgres). */
async function routeAfterReview(state: any) {
  if (!state.verdict) return END; // developer exhausted retries
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
    .addNode("syncJira", syncJiraNode)
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
    .addEdge("triage", "syncJira")
    .addConditionalEdges("syncJira", routeAfterSync, ["developer", "release"])
    .addEdge("developer", "reviewer")
    .addConditionalEdges("reviewer", routeAfterReview, ["developer", "deploy", END])
    .addEdge("deploy", "scan") // one resolved ticket re-triggers a re-scan of the whole loop
    .addEdge("release", END);

  return graph;
}

// traceable at the top of the whole cycle so it's the one LangSmith root run
// for this invocation — every agent below is independently traceable() too,
// and traceable's context propagation (plain async-call-chain based, not
// LangGraph's own callback system) means they all nest under this root
// automatically, regardless of whether LangGraph's internal tracing bridges
// to LangSmith on its own.
export const runOrchestratorCycle = traceable(_runOrchestratorCycle, { name: "orchestrator-cycle", run_type: "chain" });

async function _runOrchestratorCycle() {
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
    { cycleId: cycle.id, ticketId: null },
    { configurable: { thread_id: cycle.id } },
  );
}
