/**
 * LangGraph orchestrator — single-branch batch pipeline, direct-to-qa (no PR):
 *
 *   recoverDanglingWork → [in-progress tickets stranded by a crashed prior
 *     run, with a recoverable branch?]
 *       yes → pushBranch → reviewBranch → ... (rejoins the normal flow below
 *             at "review the entire branch")
 *       no  → scan → triage (verifies any "in_review" tickets from a prior
 *             merge against the fresh scan — see triage-from-reports.ts — and
 *             decides release vs. continue) → [tickets still unresolved?]
 *     yes → preProcessEmail → prepareBranch (one branch for all open tickets)
 *         → fixNext (developer fixes one ticket, commits) → [more tickets?]
 *             yes → fixNext (loop)
 *             no  → pushBranch → reviewBranch (reviews the whole branch diff:
 *                   scope guard, build/lint/test gate, adversarial review)
 *                   → [approved?]
 *                     yes → mergeBranch (git-merges the branch straight into
 *                           QA_BRANCH — no PR) → cleanup
 *                     no  → fixBranch (autofix — Fix Agent addresses build/
 *                           lint/test failures or blocking findings on the
 *                           same branch) → reviewBranch (retry, up to
 *                           MAX_REVIEW_RETRIES) → still failing → cleanup (+ alert)
 *   cleanup → scan (always re-verify against the freshly-deployed site — a
 *             merge alone never proves the live site is fixed)
 *     no  → release (all of this cycle's tickets are done/parked/flagged;
 *           release opens a PR from QA_BRANCH into main and emails the report)
 */
import "dotenv/config";
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { db } from "../db/client.js";
import { tickets, issues, iterationCycles, fixAttempts, reportsGenerated } from "../db/schema.js";
import { eq, and, inArray, notInArray, isNull } from "drizzle-orm";
import { triageFromReports } from "../triage/triage-from-reports.js";
import { fixTicketOnBranch, fixBuildErrors, recordFixAttempts, type BatchFixResult } from "../development/developer-agent.js";
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
import { withRetry } from "../lib/retry.js";
import { assertTargetRepoConfigured, ensureFreshQaBase, assertRepoReadyForCycle } from "../lib/repo-config.js";
import { validateConfig } from "../lib/preflight.js";
import { runWithCycleLogger, logger } from "../lib/logger.js";
import { categorizeCycleFailure } from "./failure-category.js";
import { LABEL_PREFIX, LABEL_PREFIX_SLUG } from "../lib/config.js";
import { logAudit } from "../lib/audit-log.js";
import { notifyUnrecoverableError } from "../lib/notify.js";
import { sendEmail } from "../integrations/email.js";
import { renderPreProcessEmailHtml, renderPreProcessEmailText } from "../integrations/report-template.js";
import { join } from "node:path";
import path from "node:path";
import { existsSync } from "node:fs";

const MAX_CYCLES = 20;
const MAX_REVIEW_RETRIES = parseInt(process.env.MAX_REVIEW_RETRIES ?? "2", 10);
const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const TARGET_REPO_PATH = process.env.TARGET_REPO_PATH ?? "";
const QA_BRANCH = process.env.GITHUB_QA_BRANCH ?? "qa";

const tracker = getTrackerProvider();
const vcs = getVcsProvider();

export type CycleMode = "scan" | "triage" | "full";

const CycleState = Annotation.Root({
  cycleId: Annotation<string>,
  cycleNumber: Annotation<number>,
  mode: Annotation<CycleMode>,
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

const DEPLOY_SETTLE_MS = parseInt(process.env.DEPLOY_SETTLE_MS ?? "150000", 10);

// ── Nodes ──────────────────────────────────────────────────────────────────

/**
 * Cold-start recovery: every fresh invocation starts a brand-new LangGraph
 * thread_id (see _runOrchestratorCycle), so if a previous process died mid-cycle
 * (crash, kill -9, container restart) after tickets were moved to "in_progress"
 * and a branch was created, that work is invisible to LangGraph's own
 * checkpoint resume — it belongs to a thread nobody will ever resume. Without
 * this node, prepareBranch only ever looks at status="open" tickets, so it
 * reports "no open tickets" and the orchestrator jumps straight to release,
 * leaving the dangling branch unreviewed and unmerged forever.
 *
 * This runs once at the very start of every invocation (before "scan") and
 * looks for tickets stuck in "in_progress"/"in_review" with a recoverable
 * branch. If found, it reconstructs the graph state needed to re-enter the
 * normal pushBranch → reviewBranch → mergeBranch pipeline for that branch —
 * unless the branch turns out to already be merged (crash happened between
 * merge and verification), in which case it skips straight to a verification
 * scan instead of merging a second time.
 */
async function recoverDanglingWorkNode(state: typeof CycleState.State) {
  // Dangling-work recovery is a "full pipeline" concern — a scan-only or
  // triage-only run should never reach into another run's stranded fix
  // branch just because it happened to start while one was stuck.
  if (state.mode !== "full") return {};

  // "in_progress" = claimed by prepareBranch but the developer agent never
  // committed; "in_review" = committed (and possibly merged) but the process
  // died before the post-merge verification pass could confirm it. Both are stuck
  // mid-flight work from a crashed prior run.
  const stuckTickets = await db.select().from(tickets).where(inArray(tickets.status, ["in_progress", "in_review"]));
  if (stuckTickets.length === 0) return {};

  const ticketIds = stuckTickets.map((t) => t.id);
  const attempts = await db.select().from(fixAttempts).where(inArray(fixAttempts.ticketId, ticketIds));

  const latestByTicket = new Map<string, typeof fixAttempts.$inferSelect>();
  for (const a of attempts) {
    const cur = latestByTicket.get(a.ticketId);
    if (!cur || a.createdAt > cur.createdAt) latestByTicket.set(a.ticketId, a);
  }

  interface BranchGroup {
    ticketIds: string[];
    latestCreatedAt: Date;
  }
  const byBranch = new Map<string, BranchGroup>();
  for (const [ticketId, attempt] of latestByTicket) {
    if (!attempt.branch) continue;
    const group = byBranch.get(attempt.branch) ?? { ticketIds: [], latestCreatedAt: attempt.createdAt };
    group.ticketIds.push(ticketId);
    if (attempt.createdAt > group.latestCreatedAt) group.latestCreatedAt = attempt.createdAt;
    byBranch.set(attempt.branch, group);
  }

  // Tickets stuck in_progress with no fix-attempt row at all (crashed before
  // the first commit) have nothing to recover — send them back to the queue.
  const recoverableTicketIds = new Set([...byBranch.values()].flatMap((g) => g.ticketIds));
  const orphanTicketIds = ticketIds.filter((id) => !recoverableTicketIds.has(id));
  if (orphanTicketIds.length > 0) {
    console.warn(`[orchestrate] ${orphanTicketIds.length} in-progress ticket(s) had no recoverable branch — resetting to open.`);
    await db.update(tickets).set({ status: "open" }).where(inArray(tickets.id, orphanTicketIds));
  }

  if (byBranch.size === 0) return {};

  // Only one batch can be actively resumed per invocation; if more than one
  // dangling branch exists (e.g. two separate crashes), resume the most
  // recently active one now — the next invocation of this node will pick up
  // the rest, since their tickets are still "in_progress" until then.
  const [branch, group] = [...byBranch.entries()].sort(
    (a, b) => b[1].latestCreatedAt.getTime() - a[1].latestCreatedAt.getTime(),
  )[0];

  console.log(
    `[orchestrate] Found dangling in-progress work on branch "${branch}" (${group.ticketIds.length} ticket(s)) from a previous interrupted run — resuming review/merge instead of reporting "no open tickets".`,
  );

  assertTargetRepoConfigured();
  const worktreeDir = join(TARGET_REPO_PATH, "..", ".worktrees", branch.replace(/\//g, "-"));
  let recovered = existsSync(worktreeDir);

  if (!recovered) {
    const releaseLock = await gitRepoMutex.acquire();
    try {
      try {
        await run("git", ["worktree", "add", worktreeDir, branch], TARGET_REPO_PATH);
        recovered = true;
      } catch {
        // Local branch ref is gone too (e.g. worktree dir manually deleted) —
        // fall back to the pushed remote branch, since pushBranch already
        // pushed it before the process died.
        await run("git", ["fetch", "origin", branch], TARGET_REPO_PATH);
        await run("git", ["worktree", "add", "-b", branch, worktreeDir, `origin/${branch}`], TARGET_REPO_PATH);
        recovered = true;
      }
    } catch (err) {
      console.warn(
        `[orchestrate] Could not recover branch "${branch}" from local refs or origin — resetting its ticket(s) to open.`,
        (err as Error).message?.slice(0, 200),
      );
    } finally {
      releaseLock();
    }
  }

  if (!recovered) {
    await db.update(tickets).set({ status: "open" }).where(inArray(tickets.id, group.ticketIds));
    return {};
  }

  // Reuse the recovered tickets' own epicKey (rather than letting triageNode
  // mint a fresh one for this invocation) so the verification pass can find
  // them by epic once we're back at scan/triage.
  const epicKey = stuckTickets.find((t) => group.ticketIds.includes(t.id))?.epicKey ?? null;

  // A branch merged directly into QA (no PR) leaves no server-side "merged"
  // status to check, unlike the old PR-gated flow — so if the process died
  // between merge and the post-merge verification scan, the branch itself is
  // already an ancestor of QA_BRANCH. Detect that here to avoid merging it a
  // second time; route straight to a verification scan instead.
  let alreadyMerged = false;
  const mergeCheckLock = await gitRepoMutex.acquire();
  try {
    await run("git", ["fetch", "origin", QA_BRANCH], TARGET_REPO_PATH);
    await run("git", ["merge-base", "--is-ancestor", branch, `origin/${QA_BRANCH}`], TARGET_REPO_PATH);
    alreadyMerged = true;
  } catch {
    alreadyMerged = false;
  } finally {
    mergeCheckLock();
  }

  if (alreadyMerged) {
    console.log(`[orchestrate] Branch "${branch}" is already merged into ${QA_BRANCH} — skipping re-review/merge, going straight to verification.`);
    await removeWorktreeWithRetry(worktreeDir, null);
    await logAudit({
      cycleId: state.cycleId,
      action: "recovery.dangling_work_already_merged",
      actor: "orchestrator",
      entityType: "branch",
      entityId: branch,
      details: { ticketCount: group.ticketIds.length },
      status: "success",
    });
    return { epicKey, branch: null, worktreeDir: null, freshScan: false };
  }

  for (const t of stuckTickets) {
    if (group.ticketIds.includes(t.id) && t.jiraKey) {
      try {
        await tracker.comment(t.jiraKey, `Resuming an interrupted remediation run — recovered branch \`${branch}\` and continuing the review/merge process.`);
      } catch { /* best-effort */ }
    }
  }

  await logAudit({
    cycleId: state.cycleId,
    action: "recovery.dangling_work_resumed",
    actor: "orchestrator",
    entityType: "branch",
    entityId: branch,
    details: { ticketCount: group.ticketIds.length },
    status: "success",
  });

  return {
    epicKey,
    branch,
    worktreeDir,
    fixedTicketIds: group.ticketIds,
    openTicketIds: [],
    currentTicketIndex: 0,
    reviewVerdict: null,
    retryCount: 0,
    freshScan: false,
  };
}

function routeAfterRecovery(state: typeof CycleState.State) {
  if (state.branch) {
    console.log(`[orchestrate] Resuming pipeline on recovered branch ${state.branch} — skipping scan/triage for this pass.`);
    return "pushBranch";
  }
  return "scan";
}

// Scanning (Playwright/axe only, no model call) — not wrapped in runAgentTrace
// so LangSmith traces retain only nodes that invoke a model or the Claude API.
async function scanNode(state: typeof CycleState.State) {
  return withSpan("scan.playwright", async () => {
    if (state.cycleNumber > 0) {
      console.log(`[orchestrate] Waiting ${DEPLOY_SETTLE_MS / 1000}s for CI/CD to deploy merged changes...`);
      await new Promise((r) => setTimeout(r, DEPLOY_SETTLE_MS));
    }
    console.log("[orchestrate] Running Playwright + axe scan via headless test:a11y...");
    try {
      await run("npx", ["playwright", "test", "--workers=1"], PROJECT_ROOT);
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

/** "scan" mode stops right after the report is generated — no ticket creation. */
export function routeAfterScan(state: typeof CycleState.State) {
  return state.mode === "scan" ? "finish" : "triage";
}

async function triageNode(state: typeof CycleState.State) {
  return runAgentTrace("triage", async () => {
    console.log("[orchestrate] Running triage from reports...");
    const epicKey = state.epicKey ?? (await tracker.ensureEpic(state.cycleId));
    const result = await triageFromReports({ cycleId: state.cycleId, epicKey });
    console.log(`[orchestrate] Triage complete: ${result.dbSync.ticketsCreated} ticket(s) created, ${result.summary.totalViolationTypes} violation type(s).`);
    return { epicKey };
  });
}

/**
 * Decides release vs. continue-fixing after every triage pass — including
 * the post-merge verification pass, since triageFromReports has just
 * confirmed (via per-ticket fingerprint matching) which "in_review" tickets
 * are genuinely done vs. still failing. A merge alone never ends a cycle;
 * only an all-resolved check right here does.
 */
export async function routeAfterTriage(state: typeof CycleState.State) {
  // "triage" mode always stops right after tickets are created — never falls
  // through to release, even in the edge case where this triage pass found
  // zero *new* violations and every ticket happens to already be "done" from
  // an earlier full-mode run (which would otherwise look "all resolved").
  if (state.mode === "triage") {
    return "preProcessEmail";
  }
  if (state.cycleNumber >= MAX_CYCLES) {
    console.log(`[orchestrate] Max cycles reached — moving to release.`);
    return "release";
  }
  const epicFilter = state.epicKey ? eq(tickets.epicKey, state.epicKey) : undefined;
  const unresolved = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(epicFilter ? and(epicFilter, notInArray(tickets.status, ["done", "parked", "flagged"])) : notInArray(tickets.status, ["done", "parked", "flagged"]));

  if (unresolved.length === 0) {
    console.log(`[orchestrate] All ticket(s) for cycle ${state.cycleId} are resolved (done/parked/flagged) — releasing.`);
    return "release";
  }
  console.log(`[orchestrate] ${unresolved.length} ticket(s) still unresolved — continuing to fix.`);
  return "preProcessEmail";
}

const A11Y_REPORT_PATH = join(PROJECT_ROOT, "a11y-reports", "index.html");

// Sends the pre-process notification once per cycle (idempotent via
// reportsGenerated) — no model call, not wrapped in runAgentTrace.
async function preProcessEmailNode(state: typeof CycleState.State) {
  try {
    const [already] = await db
      .select()
      .from(reportsGenerated)
      .where(and(eq(reportsGenerated.cycleId, state.cycleId), eq(reportsGenerated.type, "pre_process_email")));
    if (already) {
      console.log(`[orchestrate] Pre-process email already sent for cycle ${state.cycleId} — skipping.`);
      return {};
    }

    const epicFilter = state.epicKey ? eq(tickets.epicKey, state.epicKey) : undefined;
    const openTickets = epicFilter
      ? await db.select().from(tickets).where(and(eq(tickets.status, "open"), epicFilter))
      : await db.select().from(tickets).where(eq(tickets.status, "open"));

    const ticketIssueIds = openTickets.flatMap((t) => (t.issueIds as string[] | null) ?? []);
    const relatedIssues = ticketIssueIds.length > 0
      ? await db.select().from(issues).where(inArray(issues.id, ticketIssueIds))
      : [];
    const severityCounts: Record<string, number> = {};
    for (const i of relatedIssues) {
      severityCounts[i.severity] = (severityCounts[i.severity] ?? 0) + 1;
    }

    const data = {
      projectLabel: LABEL_PREFIX,
      cycleId: state.cycleId,
      generatedAt: new Date(),
      totalIssues: relatedIssues.length,
      severityCounts,
      tickets: openTickets.map((t) => ({ jiraKey: t.jiraKey, id: t.id, category: t.category })),
      plannedBranch: null,
    };

    const attachments = existsSync(A11Y_REPORT_PATH) ? [{ filename: "a11y-report.html", path: A11Y_REPORT_PATH }] : undefined;

    await sendEmail(
      `[${LABEL_PREFIX}] Cycle ${state.cycleId} — pre-process report`,
      renderPreProcessEmailText(data),
      renderPreProcessEmailHtml(data),
      attachments,
    );

    await db
      .insert(reportsGenerated)
      .values({ cycleId: state.cycleId, type: "pre_process_email", filePath: null })
      .onConflictDoNothing({ target: [reportsGenerated.cycleId, reportsGenerated.type] });

    await logAudit({
      cycleId: state.cycleId,
      action: "email.pre_process_sent",
      actor: "orchestrator",
      details: { totalIssues: relatedIssues.length, ticketCount: openTickets.length },
      status: "success",
    });
  } catch (err) {
    console.warn(`[orchestrate] Pre-process email failed for cycle ${state.cycleId} — continuing.`, (err as Error).message?.slice(0, 300));
    await logAudit({
      cycleId: state.cycleId,
      action: "email.pre_process_failed",
      actor: "orchestrator",
      details: { error: (err as Error).message?.slice(0, 300) },
      status: "failure",
    });
  }
  return {};
}

/** "triage" mode stops right after the pre-process email — no fixing is attempted. */
export function routeAfterPreProcessEmail(state: typeof CycleState.State) {
  return state.mode === "full" ? "prepareBranch" : "finish";
}

// Terminal node for "scan" and "triage" modes — releaseNode sets endedAt for
// "full" runs, but scan/triage runs never reach it, so this is what closes
// out the iteration_cycles row for them (without it, the run would look
// perpetually "in progress" to the web dashboard once the process exits).
async function finishNode(state: typeof CycleState.State) {
  console.log(`[orchestrate] "${state.mode}" run complete for cycle ${state.cycleId}.`);
  await db.update(iterationCycles).set({ endedAt: new Date() }).where(eq(iterationCycles.id, state.cycleId));
  return {};
}

// Git/DB setup only, no model call — not wrapped in runAgentTrace.
async function prepareBranchNode(state: typeof CycleState.State) {
  const repoPath = assertTargetRepoConfigured();
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
    await ensureFreshQaBase(repoPath);
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

  await db.update(tickets).set({ status: "in_progress" }).where(inArray(tickets.id, ticketIds));
  for (const t of openTickets) {
    if (t.jiraKey) {
      try {
        await tracker.transitionTicket(t.jiraKey, "In Progress");
      } catch (err) {
        console.warn(`[orchestrate] Failed to transition ${t.jiraKey} to In Progress:`, (err as Error).message?.slice(0, 200));
      }
    }
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

    let result: BatchFixResult;
    try {
      result = await fixTicketOnBranch(ticketId, state.worktreeDir!);
    } catch (err) {
      console.error(`[orchestrate] ✗ ticket ${ticketId.slice(0, 8)} threw an error — skipping.`, (err as Error).message?.slice(0, 300));
      await db.update(tickets).set({ status: "open" }).where(eq(tickets.id, ticketId));
      try {
        const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
        if (ticket?.jiraKey) await tracker.transitionTicket(ticket.jiraKey, "To Do");
      } catch { /* best-effort Jira rollback */ }
      return { currentTicketIndex: state.currentTicketIndex + 1 };
    }

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

const PUSH_MAX_RETRIES = 3;
const PUSH_RETRY_DELAY_MS = 3000;

// Shared push-with-retry helper — backs both pushBranchNode and fixPRNode's
// re-push after a Fix Agent commit. Serializes on gitRepoMutex per attempt
// since git holds a repo-level lock.
async function pushBranchWithRetry(worktreeDir: string, branch: string, label: string): Promise<void> {
  const authRemote = vcs.authenticatedRemoteUrl();
  await withRetry(
    async () => {
      const releaseLock = await gitRepoMutex.acquire();
      try {
        if (authRemote) {
          await run("git", ["remote", "set-url", "origin", authRemote], worktreeDir);
        }
        await run("git", ["-c", "credential.helper=", "push", "-u", "origin", branch], worktreeDir);
      } finally {
        releaseLock();
      }
    },
    { retries: PUSH_MAX_RETRIES, delayMs: PUSH_RETRY_DELAY_MS, label },
  );
}

// git push only, no model call — not wrapped in runAgentTrace.
async function pushBranchNode(state: typeof CycleState.State) {
  await pushBranchWithRetry(state.worktreeDir!, state.branch!, `push branch ${state.branch}`);
  console.log(`[orchestrate] Pushed branch ${state.branch} with ${state.fixedTicketIds.length} fix commit(s).`);
  return {};
}

async function reviewBranchNode(state: typeof CycleState.State) {
  return runAgentTrace("reviewer", async () => {
    console.log(`[orchestrate] Reviewing branch ${state.branch} (${state.fixedTicketIds.length} ticket(s))...`);
    const result = await reviewBranch(state.worktreeDir!, state.fixedTicketIds, null, state.cycleId);
    console.log(`[orchestrate] Reviewer verdict: ${result.verdict}${result.scopeGuardFlagged ? " (scope-flagged)" : ""} (${result.blockingFindingsCount} blocking finding(s))`);
    return { reviewVerdict: result.verdict, reviewComments: result.comments };
  });
}

function routeAfterReviewBranch(state: typeof CycleState.State) {
  if (state.reviewVerdict === "approved") {
    return "mergeBranch";
  }
  if (state.retryCount < MAX_REVIEW_RETRIES) {
    console.log(`[orchestrate] Review rejected (attempt ${state.retryCount + 1}/${MAX_REVIEW_RETRIES}) — running autofix.`);
    return "fixBranch";
  }
  console.log(`[orchestrate] Review rejected after ${MAX_REVIEW_RETRIES} retries — giving up.`);
  return "cleanup";
}

// Autofix — addresses build/lint/test failures or blocking review findings
// on the same branch, then re-review. No PR to update, just re-push.
async function fixBranchNode(state: typeof CycleState.State) {
  return runAgentTrace("developer", async () => {
    console.log(`[orchestrate] Fix Agent addressing review feedback (retry ${state.retryCount + 1}/${MAX_REVIEW_RETRIES})...`);

    let commitSha: string | null = null;
    try {
      commitSha = await fixBuildErrors(state.worktreeDir!, state.reviewComments ?? "Build failed");
    } catch (err) {
      console.error(`[orchestrate] Fix Agent failed:`, (err as Error).message?.slice(0, 300));
      return { retryCount: state.retryCount + 1 };
    }

    if (commitSha) {
      console.log(`[orchestrate] Fix Agent committed: ${commitSha.slice(0, 7)} — re-pushing to the same branch...`);
      // Record a new attempt per ticket for this commit — without this,
      // deploy-agent's independent fix_attempts/review_results re-check would
      // keep finding the earlier rejected attempt as "latest" after a retry.
      await recordFixAttempts(state.fixedTicketIds, state.branch!, commitSha);
      try {
        await pushBranchWithRetry(state.worktreeDir!, state.branch!, `fixBranch re-push ${state.branch}`);
      } catch (err) {
        console.error(`[orchestrate] Fix Agent push failed:`, (err as Error).message?.slice(0, 300));
      }
    } else {
      console.warn(`[orchestrate] Fix Agent made no changes.`);
    }

    return { retryCount: state.retryCount + 1 };
  });
}

async function mergeBranchNode(state: typeof CycleState.State) {
  return runAgentTrace("deploy", async () => {
    console.log(`[orchestrate] Merging branch ${state.branch} into ${QA_BRANCH}...`);
    try {
      const result = await deployBranch(state.branch!, state.fixedTicketIds, state.cycleId);
      if (result.status === "succeeded") {
        console.log(`[orchestrate] Merge complete — ${result.ticketsDeployed} ticket(s) merged, awaiting verification.`);
      } else {
        console.warn(`[orchestrate] Merge ${result.status}${result.blockReason ? `: ${result.blockReason}` : ""}.`);
        if (result.status === "failed") {
          await notifyUnrecoverableError({
            cycleId: state.cycleId,
            stage: "mergeBranch",
            action: "merge_failed",
            error: new Error(result.blockReason ?? "Merge failed after retries/conflict resolution."),
            details: { branch: state.branch },
          });
        }
      }
    } catch (err) {
      console.error(`[orchestrate] Merge failed for branch ${state.branch}:`, (err as Error).message?.slice(0, 300));
      for (const ticketId of state.fixedTicketIds) {
        await db.update(tickets).set({ status: "open" }).where(eq(tickets.id, ticketId));
      }
      await notifyUnrecoverableError({
        cycleId: state.cycleId,
        stage: "mergeBranch",
        action: "merge_threw",
        error: err,
        details: { branch: state.branch },
      });
    }
    return { freshScan: false };
  });
}

const WORKTREE_REMOVE_RETRIES = 3;
const WORKTREE_RETRY_DELAY_MS = 2000;

async function removeWorktreeWithRetry(worktreeDir: string, branch: string | null) {
  for (let attempt = 1; attempt <= WORKTREE_REMOVE_RETRIES; attempt++) {
    const releaseLock = await gitRepoMutex.acquire();
    try {
      await run("git", ["worktree", "remove", "--force", worktreeDir], TARGET_REPO_PATH);
      console.log(`[orchestrate] Removed worktree at ${worktreeDir}.`);
      if (branch) {
        try {
          await run("git", ["branch", "-D", branch], TARGET_REPO_PATH);
        } catch { /* branch may already be gone */ }
      }
      return;
    } catch (err) {
      if (attempt < WORKTREE_REMOVE_RETRIES) {
        console.warn(`[orchestrate] Worktree removal attempt ${attempt}/${WORKTREE_REMOVE_RETRIES} failed, retrying in ${WORKTREE_RETRY_DELAY_MS / 1000}s...`, (err as Error).message?.slice(0, 200));
      } else {
        console.error(`[orchestrate] Could not remove worktree at ${worktreeDir} after ${WORKTREE_REMOVE_RETRIES} attempts.`);
      }
    } finally {
      releaseLock();
    }
    await new Promise((r) => setTimeout(r, WORKTREE_RETRY_DELAY_MS));
  }
}

// Worktree/DB cleanup only, no model call — not wrapped in runAgentTrace.
async function cleanupNode(state: typeof CycleState.State) {
  // Review-retry budget exhausted — this is the give-up path, not the
  // routine "no commits produced" early exit. Alert so a human can pick up
  // the still-pushed branch rather than losing the work.
  if (state.reviewVerdict === "rejected" && state.retryCount >= MAX_REVIEW_RETRIES) {
    await notifyUnrecoverableError({
      cycleId: state.cycleId,
      stage: "reviewBranch",
      action: "review_retries_exhausted",
      error: new Error(`Branch ${state.branch} still rejected after ${MAX_REVIEW_RETRIES} review/fix cycles.`),
      details: { branch: state.branch },
    });
  }

  if (state.worktreeDir) {
    await removeWorktreeWithRetry(state.worktreeDir, state.branch);
  }

  // Reset unfixed tickets back to open
  if (state.reviewVerdict === "rejected") {
    for (const ticketId of state.fixedTicketIds) {
      await db.update(tickets).set({ status: "open" }).where(eq(tickets.id, ticketId));
    }
  }

  // Reset any tickets still stuck in in_progress (e.g. agent crashed mid-fix)
  if (state.openTicketIds.length > 0) {
    await db.update(tickets).set({ status: "open" }).where(
      and(eq(tickets.status, "in_progress"), inArray(tickets.id, state.openTicketIds)),
    );
  }

  return { branch: null, worktreeDir: null, openTicketIds: [], fixedTicketIds: [], currentTicketIndex: 0 };
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
    .addNode("recoverDanglingWork", recoverDanglingWorkNode)
    .addNode("scan", scanNode)
    .addNode("triage", triageNode)
    .addNode("preProcessEmail", preProcessEmailNode)
    .addNode("prepareBranch", prepareBranchNode)
    .addNode("fixNext", fixNextNode)
    .addNode("pushBranch", pushBranchNode)
    .addNode("reviewBranch", reviewBranchNode)
    .addNode("fixBranch", fixBranchNode)
    .addNode("mergeBranch", mergeBranchNode)
    .addNode("cleanup", cleanupNode)
    .addNode("finish", finishNode)
    .addNode("release", releaseNode)
    .addEdge(START, "recoverDanglingWork")
    .addConditionalEdges("recoverDanglingWork", routeAfterRecovery, ["pushBranch", "scan"])
    .addConditionalEdges("scan", routeAfterScan, ["triage", "finish"])
    .addConditionalEdges("triage", routeAfterTriage, ["preProcessEmail", "release"])
    .addConditionalEdges("preProcessEmail", routeAfterPreProcessEmail, ["prepareBranch", "finish"])
    .addConditionalEdges("prepareBranch", routeAfterPrepareBranch, ["fixNext", "release", "scan"])
    .addConditionalEdges("fixNext", routeAfterFix, ["fixNext", "pushBranch", "cleanup"])
    .addEdge("pushBranch", "reviewBranch")
    .addConditionalEdges("reviewBranch", routeAfterReviewBranch, ["mergeBranch", "fixBranch", "cleanup"])
    .addEdge("fixBranch", "reviewBranch")
    .addEdge("mergeBranch", "cleanup")
    // Always re-verify against the freshly-deployed site — a ticket only
    // ever leaves "in_review" via the verification pass inside triageNode,
    // so there's no shortcut to "release" from here anymore.
    .addEdge("cleanup", "scan")
    .addEdge("finish", END)
    .addEdge("release", END);

  return graph;
}

export async function runOrchestratorCycle(existingCycleId?: string, mode: CycleMode = "full"): Promise<void> {
  return _runOrchestratorCycle(existingCycleId, mode);
}

async function _runOrchestratorCycle(existingCycleId?: string, mode: CycleMode = "full") {
  // When a caller (e.g. the web app's start API route) has already inserted
  // the iteration_cycles row so it can hand back the run id synchronously,
  // reuse that row instead of creating a second one. That row's own "mode"
  // column (set at insert time) is the source of truth for what was
  // actually requested — the "mode" argument here only matters when this
  // call creates its own fresh row (standalone CLI usage).
  const cycle = existingCycleId
    ? (await db.select().from(iterationCycles).where(eq(iterationCycles.id, existingCycleId)))[0]
    : (
        await db
          .insert(iterationCycles)
          .values({ cycleNumber: 0, openIssueCount: 0, mode })
          .returning()
      )[0];

  if (!cycle) {
    throw new Error(`No iteration_cycles row found for id ${existingCycleId}`);
  }

  const cycleMode = (cycle.mode as CycleMode | undefined) ?? mode;

  await runWithCycleLogger(cycle.id, async () => {
    try {
      validateConfig({
        db: true,
        repo: cycleMode !== "scan",
        jira: cycleMode !== "scan",
        github: cycleMode === "full",
      });

      logger.info("orchestrate", `Starting pipeline — cycle ${cycle.id} (mode: ${cycleMode})`);
      logger.info(
        "orchestrate",
        `Flow: recoverDanglingWork → scan → [mode=scan? finish : triage (verify + decide)] → [mode=triage? preProcessEmail → finish : preProcessEmail → prepareBranch → fix (all tickets) → push → reviewBranch → mergeBranch (direct, no PR) / fixBranch (autofix) → cleanup → scan → triage → [all resolved?] → release (PR to main + email), else continue]`,
      );

      if (cycleMode === "full") {
        await assertRepoReadyForCycle();
      }

      const { initObservability } = await import("../integrations/observability.js");
      await initObservability();

      const checkpointer = PostgresSaver.fromConnString(process.env.DATABASE_URL!);
      await checkpointer.setup();

      const compiled = buildGraph().compile({ checkpointer });

      await runWithPipelineContext({ pipeline_run_id: cycle.id, cycle_number: 0 }, async () =>
        runIssueResolutionPipeline(async () => {
          await compiled.invoke(
            {
              cycleId: cycle.id,
              cycleNumber: 0,
              mode: cycleMode,
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
    } catch (err) {
      const { category, reason } = categorizeCycleFailure(err);
      logger.error("orchestrate", `Cycle ${cycle.id} failed (${category}): ${reason}`, err);
      logger.error("orchestrate", `CYCLE_FAILED: ${category} | ${reason}`);
      throw err;
    } finally {
      await db
        .update(iterationCycles)
        .set({ endedAt: new Date() })
        .where(and(eq(iterationCycles.id, cycle.id), isNull(iterationCycles.endedAt)));
    }
  });
}
