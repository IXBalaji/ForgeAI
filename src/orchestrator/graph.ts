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
import { desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { tickets, iterationCycles, fixAttempts, reviewResults } from "../db/schema.js";
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
  fixAttemptId: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  reviewVerdict: Annotation<"approved" | "rejected" | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  scopeGuardFlagged: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
  shouldRetry: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
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

  // 1. Recover stale "in_review" tickets from a previous crashed run
  const staleTickets = epicKey
    ? await db.select().from(tickets).where(and(eq(tickets.status, "in_review"), eq(tickets.epicKey, epicKey)))
    : await db.select().from(tickets).where(eq(tickets.status, "in_review"));

  const sends: Send[] = [];

  for (const ticket of staleTickets) {
    const [latestAttempt] = await db
      .select()
      .from(fixAttempts)
      .where(eq(fixAttempts.ticketId, ticket.id))
      .orderBy(desc(fixAttempts.createdAt))
      .limit(1);

    if (!latestAttempt) {
      // Has no fix attempt — reset to open so developer picks it up
      await db.update(tickets).set({ status: "open" }).where(eq(tickets.id, ticket.id));
      console.log(`[orchestrate] Recovered ticket ${ticket.jiraKey ?? ticket.id} — no fix attempt, reset to open.`);
      continue;
    }

    const [review] = await db
      .select()
      .from(reviewResults)
      .where(eq(reviewResults.fixAttemptId, latestAttempt.id));

    if (!review) {
      // Has fix attempt but no review — send to reviewer
      console.log(`[orchestrate] Recovered ticket ${ticket.jiraKey ?? ticket.id} — fix attempt exists, sending to reviewer.`);
      sends.push(new Send("reviewer", { ticketId: ticket.id, epicKey, fixAttemptId: latestAttempt.id }));
    } else if (review.verdict === "approved" && !review.scopeGuardFlagged) {
      // Reviewed and approved but never deployed — send to deploy
      console.log(`[orchestrate] Recovered ticket ${ticket.jiraKey ?? ticket.id} — approved but not deployed, sending to deploy.`);
      sends.push(new Send("deploy", { ticketId: ticket.id, epicKey, fixAttemptId: latestAttempt.id }));
    } else {
      // Reviewed but rejected/flagged — reset to open for retry
      await db.update(tickets).set({ status: "open" }).where(eq(tickets.id, ticket.id));
      console.log(`[orchestrate] Recovered ticket ${ticket.jiraKey ?? ticket.id} — review ${review.verdict}, reset to open.`);
    }
  }

  // 2. Pick up new "open" tickets as before
  const openTickets = epicKey
    ? await db.select().from(tickets).where(and(eq(tickets.status, "open"), eq(tickets.epicKey, epicKey)))
    : await db.select().from(tickets).where(eq(tickets.status, "open"));

  if (openTickets.length === 0 && sends.length === 0) {
    if (state.cycleNumber >= MAX_CYCLES) {
      console.log(`[orchestrate] Max cycles reached — moving to release.`);
    } else {
      console.log(`[orchestrate] No open or in-progress tickets — moving to release.`);
    }
    return "release";
  }

  if (state.cycleNumber >= MAX_CYCLES) {
    console.log(`[orchestrate] Max cycles reached — moving to release (${openTickets.length} open, ${sends.length} recovered).`);
    return "release";
  }

  for (const t of openTickets) {
    sends.push(new Send("developer", { ticketId: t.id, epicKey: state.epicKey }));
  }

  console.log(`[orchestrate] ${openTickets.length} open + ${staleTickets.length} recovered ticket(s) — fanning out.`);
  return sends;
}

async function developerNode(state: typeof TicketState.State) {
  return withSpan("agent.developer", async () => {
    console.log(`[orchestrate] Running developer agent on ticket ${state.ticketId}...`);
    const { fixAttemptId } = await runDeveloperAgent(state.ticketId);
    console.log(`[orchestrate] Developer done — fix attempt ${fixAttemptId}.`);
    return { fixAttemptId } as any;
  });
}

function routeDevToReviewer(state: any) {
  return new Send("reviewer", {
    ticketId: state.ticketId,
    epicKey: state.epicKey,
    fixAttemptId: state.fixAttemptId,
  });
}

async function reviewerNode(state: any) {
  return withSpan("agent.reviewer", async () => {
    console.log(`[orchestrate] Running reviewer on fix attempt ${state.fixAttemptId}...`);
    const result = await runReviewerAgent(state.fixAttemptId);
    console.log(`[orchestrate] Reviewer verdict: ${result.verdict}${result.scopeGuardFlagged ? " (scope-flagged)" : ""}.`);
    return { reviewVerdict: result.verdict, scopeGuardFlagged: result.scopeGuardFlagged } as any;
  });
}

function routeAfterReview(state: any) {
  if (state.reviewVerdict === "rejected") {
    const ticketId = state.ticketId;
    return new Send("routeRejection", { ticketId, epicKey: state.epicKey, fixAttemptId: state.fixAttemptId });
  }
  if (state.scopeGuardFlagged) return END;
  if (!state.fixAttemptId) {
    console.log(`[orchestrate] No fix attempt to deploy — skipping deploy.`);
    return END;
  }
  return new Send("deploy", {
    ticketId: state.ticketId,
    epicKey: state.epicKey,
    fixAttemptId: state.fixAttemptId,
  });
}

async function routeRejectionNode(state: any) {
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, state.ticketId));
  if (ticket?.status === "open") {
    return { shouldRetry: true } as any;
  }
  return { shouldRetry: false } as any;
}

function routeRejectionEdge(state: any) {
  if (state.shouldRetry) {
    return new Send("developer", { ticketId: state.ticketId, epicKey: state.epicKey });
  }
  return END;
}

export function buildGraph() {
  const graph = new StateGraph(CycleState)
    .addNode("scan", scanNode)
    .addNode("triage", triageNode)
    .addNode("developer", developerNode as any)
    .addNode("reviewer", reviewerNode as any)
    .addNode("routeRejection", routeRejectionNode as any)
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
    .addConditionalEdges("triage", routeAfterTriage, ["developer", "reviewer", "deploy", "release"])
    .addConditionalEdges("developer", routeDevToReviewer, ["reviewer"])
    .addConditionalEdges("reviewer", routeAfterReview, ["routeRejection", "deploy", END])
    .addConditionalEdges("routeRejection", routeRejectionEdge, ["developer", END])
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
    { cycleId: cycle.id, cycleNumber: 0, epicKey: null, ticketId: null, fixAttemptId: null, reviewVerdict: null, scopeGuardFlagged: false },
    { configurable: { thread_id: cycle.id } },
  );
}
