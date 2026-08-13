/**
 * LangGraph orchestrator — single-branch batch pipeline:
 *
 *   scan → triage → [open tickets?]
 *     yes → prepareBranch (one branch for all tickets)
 *         → fixNext (developer fixes one ticket, commits) → [more tickets?]
 *             yes → fixNext (loop)
 *             no  → pushBranch → reviewer (reviews entire branch)
 *                   → [approved?]
 *                     yes → deploy (merges branch into QA) → cleanup → scan
 *                     no  → autofix (fix build errors) → reviewer (retry, up to MAX_REVIEW_RETRIES)
 *                           → still failing → cleanup → scan
 *     no tickets after fresh scan → release
 */
import "dotenv/config";
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { db } from "../db/client.js";
import { tickets, iterationCycles } from "../db/schema.js";
import { eq, and, inArray } from "drizzle-orm";
import { triageFromReports } from "../triage/triage-from-reports.js";
import { fixTicketOnBranch, fixBuildErrors, type BatchFixResult } from "../development/developer-agent.js";
import { reviewBranch } from "../review/reviewer-agent.js";
import { deployBranch } from "../deploy/deploy-agent.js";
import { runReleaseAgent } from "../release/release-agent.js";
import { getTrackerProvider } from "../integrations/tracker/factory.js";
import { getVcsProvider } from "../integrations/vcs/factory.js";
import { withSpan } from "../integrations/observability.js";
import { runAgentTrace } from "../observability/agent-tracing.js";
import { runIssueResolutionPipeline } from "../observability/anthropic-tracing.js";
import { runWithPipelineContext, setPipelineCycleNumber } from "../observability/pipeline-context.js";
import { SilentLangGraphTracer } from "../observability/silent-langgraph-tracer.js";
import { run } from "../lib/exec.js";
import { gitRepoMutex } from "../lib/mutex.js";
import { LABEL_PREFIX_SLUG } from "../lib/config.js";
import { join } from "node:path";
import path from "node:path";

const MAX_CYCLES = 20;
const MAX_REVIEW_RETRIES = parseInt(process.env.MAX_REVIEW_RETRIES ?? "2", 10);
const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const TARGET_REPO_PATH = process.env.TARGET_REPO_PATH ?? "";
const QA_BRANCH = process.env.GITHUB_QA_BRANCH ?? "qa";

const tracker = getTrackerProvider();
const vcs = getVcsProvider();

const CycleState = Annotation.Root({
  cycleId: Annotation<string>,
  cycleNumber: Annotation<number>,
  epicKey: Annotation<string | null>,
  branch: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  worktreeDir: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  openTicketIds: Annotation<string[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  fixedTicketIds: Annotation<string[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  currentTicketIndex: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  reviewVerdict: Annotation<"approved" | "rejected" | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  reviewComments: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  retryCount: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  freshScan: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => true,
  }),
});

const DEPLOY_SETTLE_MS = parseInt(process.env.DEPLOY_SETTLE_MS ?? "60000", 10);

// ── Nodes ──────────────────────────────────────────────────────────────────

// Scanning (Playwright/axe only, no model call) — not wrapped in runAgentTrace
// so LangSmith traces retain only nodes that invoke a model or the Claude API.
async function scanNode(state: typeof CycleState.State) {
  return withSpan("scan.playwright", async () => {
    if (state.cycleNumber > 0) {
      console.log(`[orchestrate] Waiting ${DEPLOY_SETTLE_MS / 1000}s for CI/CD to deploy merged changes...`);
      await new Promise((r) => setTimeout(r, DEPLOY_SETTLE_MS));
    }
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
    setPipelineCycleNumber(state.cycleNumber + 1);
    return { cycleNumber: state.cycleNumber + 1, freshScan: true };
  });
}

async function triageNode(state: typeof CycleState.State) {
  return runAgentTrace("triage", async () => {
    console.log("[orchestrate] Running triage from reports...");
    const epicKey = state.epicKey ?? (await tracker.ensureEpic(state.cycleId));
    const result = await triageFromReports({ cycleId: state.cycleId });
    console.log(`[orchestrate] Triage complete: ${result.dbSync.ticketsCreated} ticket(s) created, ${result.summary.totalViolationTypes} violation type(s).`);
    return { epicKey };
  });
}

function routeAfterTriage(state: typeof CycleState.State) {
  if (state.cycleNumber >= MAX_CYCLES) {
    console.log(`[orchestrate] Max cycles reached — moving to release.`);
    return "release";
  }
  return "prepareBranch";
}

// Git/DB setup only, no model call — not wrapped in runAgentTrace.
async function prepareBranchNode(state: typeof CycleState.State) {
  const epicKey = state.epicKey;

  const openTickets = epicKey
    ? await db.select().from(tickets).where(and(eq(tickets.status, "open"), eq(tickets.epicKey, epicKey)))
    : await db.select().from(tickets).where(eq(tickets.status, "open"));

  if (openTickets.length === 0) {
    console.log(`[orchestrate] No open tickets found.`);
    return { openTicketIds: [], fixedTicketIds: [], currentTicketIndex: 0, branch: null, worktreeDir: null };
  }

  const ticketIds = openTickets.map((t) => t.id);
  const jiraKeys = openTickets.map((t) => t.jiraKey).filter(Boolean);
  const branchLabel = jiraKeys.length > 0 ? jiraKeys.join("-") : ticketIds[0].slice(0, 8);
  const branch = `${LABEL_PREFIX_SLUG}/batch-${branchLabel}-${Date.now()}`;
  const worktreeDir = join(TARGET_REPO_PATH, "..", ".worktrees", branch.replace(/\//g, "-"));

  const releaseLock = await gitRepoMutex.acquire();
  try {
    await run("git", ["fetch", "origin", QA_BRANCH], TARGET_REPO_PATH);
    const startPoint = `origin/${QA_BRANCH}`;
    try {
      await run("git", ["worktree", "add", "-b", branch, worktreeDir, startPoint], TARGET_REPO_PATH);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("already exists")) {
        try { await run("git", ["worktree", "remove", worktreeDir, "--force"], TARGET_REPO_PATH); } catch {}
        try { await run("git", ["branch", "-D", branch], TARGET_REPO_PATH); } catch {}
        await run("git", ["worktree", "add", "-b", branch, worktreeDir, startPoint], TARGET_REPO_PATH);
      } else {
        throw err;
      }
    }
  } finally {
    releaseLock();
  }

  console.log(`[orchestrate] Created branch ${branch} for ${openTickets.length} ticket(s): ${jiraKeys.join(", ") || ticketIds.map((id) => id.slice(0, 8)).join(", ")}`);
  for (const t of openTickets) {
    const issueCount = (t.issueIds as string[] | null)?.length ?? 0;
    console.log(`[orchestrate]   ${t.jiraKey ?? t.id.slice(0, 8)} — category: "${t.category}", linked issues: ${issueCount}`);
  }
  return { openTicketIds: ticketIds, fixedTicketIds: [], currentTicketIndex: 0, branch, worktreeDir };
}

function routeAfterPrepareBranch(state: typeof CycleState.State) {
  if (state.openTicketIds.length === 0) {
    if (state.freshScan) {
      console.log(`[orchestrate] No open tickets after fresh scan — moving to release.`);
      return "release";
    }
    console.log(`[orchestrate] All tickets processed — rescanning for new issues.`);
    return "scan";
  }
  return "fixNext";
}

async function fixNextNode(state: typeof CycleState.State) {
  const ticketId = state.openTicketIds[state.currentTicketIndex];
  const total = state.openTicketIds.length;
  const current = state.currentTicketIndex + 1;

  return runAgentTrace("developer", async () => {
    console.log(`[orchestrate] Fixing ticket ${current}/${total}: ${ticketId.slice(0, 8)}...`);
    const result: BatchFixResult = await fixTicketOnBranch(ticketId, state.worktreeDir!);

    const newFixed = result.commitSha
      ? [...state.fixedTicketIds, ticketId]
      : state.fixedTicketIds;

    if (result.commitSha) {
      console.log(`[orchestrate] ✓ ${result.jiraKey ?? ticketId.slice(0, 8)} committed: ${result.commitSha.slice(0, 7)}`);
    } else {
      console.warn(`[orchestrate] ✗ ${result.jiraKey ?? ticketId.slice(0, 8)} — no changes produced.`);
    }

    return { fixedTicketIds: newFixed, currentTicketIndex: state.currentTicketIndex + 1 };
  });
}

function routeAfterFix(state: typeof CycleState.State) {
  if (state.currentTicketIndex < state.openTicketIds.length) {
    return "fixNext";
  }
  if (state.fixedTicketIds.length === 0) {
    console.log(`[orchestrate] No tickets produced commits — skipping review.`);
    return "cleanup";
  }
  return "pushBranch";
}

// git push only, no model call — not wrapped in runAgentTrace.
async function pushBranchNode(state: typeof CycleState.State) {
  const releaseLock = await gitRepoMutex.acquire();
  try {
    const authRemote = vcs.authenticatedRemoteUrl();
    if (authRemote) {
      await run("git", ["remote", "set-url", "origin", authRemote], state.worktreeDir!);
    }
    await run("git", ["-c", "credential.helper=", "push", "-u", "origin", state.branch!], state.worktreeDir!);
    console.log(`[orchestrate] Pushed branch ${state.branch} with ${state.fixedTicketIds.length} fix commit(s).`);
  } finally {
    releaseLock();
  }
  return {};
}

async function reviewerNode(state: typeof CycleState.State) {
  return runAgentTrace("reviewer", async () => {
    console.log(`[orchestrate] Reviewing branch ${state.branch} (${state.fixedTicketIds.length} ticket(s))...`);
    const result = await reviewBranch(state.worktreeDir!, state.fixedTicketIds);
    console.log(`[orchestrate] Reviewer verdict: ${result.verdict}${result.scopeGuardFlagged ? " (scope-flagged)" : ""}`);
    return { reviewVerdict: result.verdict, reviewComments: result.comments };
  });
}

function routeAfterReview(state: typeof CycleState.State) {
  if (state.reviewVerdict === "approved") {
    return "deploy";
  }
  if (state.retryCount < MAX_REVIEW_RETRIES) {
    console.log(`[orchestrate] Review rejected (attempt ${state.retryCount + 1}/${MAX_REVIEW_RETRIES}) — sending back to autofix.`);
    return "autofix";
  }
  console.log(`[orchestrate] Review rejected after ${MAX_REVIEW_RETRIES} retries — giving up.`);
  return "cleanup";
}

async function autofixNode(state: typeof CycleState.State) {
  return runAgentTrace("autofix", async () => {
    console.log(`[orchestrate] Autofixing build errors (retry ${state.retryCount + 1}/${MAX_REVIEW_RETRIES})...`);
    const commitSha = await fixBuildErrors(state.worktreeDir!, state.reviewComments ?? "Build failed");

    if (commitSha) {
      console.log(`[orchestrate] Autofix committed: ${commitSha.slice(0, 7)} — re-pushing...`);
      const releaseLock = await gitRepoMutex.acquire();
      try {
        const authRemote = vcs.authenticatedRemoteUrl();
        if (authRemote) {
          await run("git", ["remote", "set-url", "origin", authRemote], state.worktreeDir!);
        }
        await run("git", ["-c", "credential.helper=", "push", "origin", state.branch!], state.worktreeDir!);
      } finally {
        releaseLock();
      }
    } else {
      console.warn(`[orchestrate] Autofix made no changes.`);
    }

    return { retryCount: state.retryCount + 1 };
  });
}

async function deployNode(state: typeof CycleState.State) {
  return runAgentTrace("deploy", async () => {
    console.log(`[orchestrate] Deploying branch ${state.branch}...`);
    const result = await deployBranch(state.branch!, state.fixedTicketIds);
    console.log(`[orchestrate] Deploy complete — ${result.ticketsDeployed} ticket(s) merged.`);
    return { freshScan: false };
  });
}

// Worktree/DB cleanup only, no model call — not wrapped in runAgentTrace.
async function cleanupNode(state: typeof CycleState.State) {
  if (!state.worktreeDir) return {};
  const releaseLock = await gitRepoMutex.acquire();
  try {
    await run("git", ["worktree", "remove", "--force", state.worktreeDir], TARGET_REPO_PATH);
  } catch {
    console.warn(`[orchestrate] Could not remove worktree at ${state.worktreeDir}.`);
  } finally {
    releaseLock();
  }

  // Reset unfixed tickets back to open
  if (state.reviewVerdict === "rejected") {
    for (const ticketId of state.fixedTicketIds) {
      await db.update(tickets).set({ status: "open" }).where(eq(tickets.id, ticketId));
    }
  }

  return { branch: null, worktreeDir: null, openTicketIds: [], fixedTicketIds: [], currentTicketIndex: 0 };
}

function routeAfterCleanup(state: typeof CycleState.State) {
  return "scan";
}

async function releaseNode(state: typeof CycleState.State) {
  return runAgentTrace("release", async () => {
    console.log(`[orchestrate] Running release for cycle ${state.cycleId}...`);
    await db.update(iterationCycles).set({ endedAt: new Date() }).where(eq(iterationCycles.id, state.cycleId));
    await runReleaseAgent(state.cycleId);
    console.log(`[orchestrate] Release complete.`);
    return {};
  });
}

// ── Graph ──────────────────────────────────────────────────────────────────

export function buildGraph() {
  const graph = new StateGraph(CycleState)
    .addNode("scan", scanNode)
    .addNode("triage", triageNode)
    .addNode("prepareBranch", prepareBranchNode)
    .addNode("fixNext", fixNextNode)
    .addNode("pushBranch", pushBranchNode)
    .addNode("reviewer", reviewerNode)
    .addNode("autofix", autofixNode)
    .addNode("deploy", deployNode)
    .addNode("cleanup", cleanupNode)
    .addNode("release", releaseNode)
    .addEdge(START, "scan")
    .addEdge("scan", "triage")
    .addConditionalEdges("triage", routeAfterTriage, ["prepareBranch", "release"])
    .addConditionalEdges("prepareBranch", routeAfterPrepareBranch, ["fixNext", "release", "scan"])
    .addConditionalEdges("fixNext", routeAfterFix, ["fixNext", "pushBranch", "cleanup"])
    .addEdge("pushBranch", "reviewer")
    .addConditionalEdges("reviewer", routeAfterReview, ["deploy", "autofix", "cleanup"])
    .addEdge("autofix", "reviewer")
    .addEdge("deploy", "cleanup")
    .addConditionalEdges("cleanup", routeAfterCleanup, ["scan"])
    .addEdge("release", END);

  return graph;
}

export async function runOrchestratorCycle(existingCycleId?: string): Promise<void> {
  return _runOrchestratorCycle(existingCycleId);
}

async function _runOrchestratorCycle(existingCycleId?: string) {
  const { initObservability } = await import("../integrations/observability.js");
  await initObservability();

  const checkpointer = PostgresSaver.fromConnString(process.env.DATABASE_URL!);
  await checkpointer.setup();

  const compiled = buildGraph().compile({ checkpointer });

  // When a caller (e.g. the web app's start API route) has already inserted
  // the iteration_cycles row so it can hand back the run id synchronously,
  // reuse that row instead of creating a second one.
  const cycle = existingCycleId
    ? (await db.select().from(iterationCycles).where(eq(iterationCycles.id, existingCycleId)))[0]
    : (
        await db
          .insert(iterationCycles)
          .values({ cycleNumber: 0, openIssueCount: 0 })
          .returning()
      )[0];

  if (!cycle) {
    throw new Error(`No iteration_cycles row found for id ${existingCycleId}`);
  }

  console.log(`[orchestrate] Starting pipeline — cycle ${cycle.id}`);
  console.log(`[orchestrate] Flow: scan → triage → prepareBranch → fix (all tickets) → push → review → deploy → release`);

  await runWithPipelineContext({ pipeline_run_id: cycle.id, cycle_number: 0 }, async () =>
    runIssueResolutionPipeline(async () => {
      await compiled.invoke(
        {
          cycleId: cycle.id,
          cycleNumber: 0,
          epicKey: null,
          branch: null,
          worktreeDir: null,
          openTicketIds: [],
          fixedTicketIds: [],
          currentTicketIndex: 0,
          reviewVerdict: null,
          reviewComments: null,
          retryCount: 0,
          freshScan: true,
        },
        {
          configurable: { thread_id: cycle.id },
          // Suppresses LangGraph's internal run tracing (_start_, ChannelWrite, node
          // wrapper runs) — the meaningful agent.* / anthropic.* runs attach directly
          // to the root "ForgeAI" run instead (see agent-tracing.ts).
          callbacks: [new SilentLangGraphTracer()],
        },
      );
    }),
  );
}
