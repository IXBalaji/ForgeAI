import { db, requireDb } from "./db";
import { iterationCycles, tickets, fixAttempts, reviewResults, deployments } from "./schema";
import { eq, or, gte, and, inArray, desc } from "drizzle-orm";
import type { RunStatus, RunMode, Stage } from "./types";

/**
 * Derive the current status of a workflow run from DB rows + log tail.
 *
 * Combines two signals:
 * - DB row counts (authoritative "confirmed so far")
 * - Log-tail regex (best-effort "what's happening right now")
 *
 * Per the plan: the DB-only heuristic is sound because the duplicate-run guard
 * guarantees at most one active cycle at a time, so rows created at/after
 * `startedAt` are presumptively this run's rows.
 */
export async function deriveRunStatus(
  cycleId: string,
  logLines: string[],
  processAlive: boolean,
  exitCode: number | null,
): Promise<RunStatus> {
  const database = requireDb();
  const [cycle] = await database.select().from(iterationCycles).where(eq(iterationCycles.id, cycleId));

  if (!cycle) {
    throw new Error(`No iteration_cycles row found for ${cycleId}`);
  }

  const mode = (cycle.mode as RunMode | undefined) ?? "full";
  const startedAt = cycle.startedAt.toISOString();
  const endedAt = cycle.endedAt?.toISOString() ?? null;

  // If the cycle is complete, surface the results
  if (endedAt) {
    const epicKey = cycle.epicKey;
    const allTickets = await database
      .select()
      .from(tickets)
      .where(
        epicKey
          ? or(gte(tickets.createdAt, cycle.startedAt), eq(tickets.epicKey, epicKey))
          : gte(tickets.createdAt, cycle.startedAt),
      );

    const fixed = allTickets.filter((t) => t.status === "done");
    const parked = allTickets.filter((t) => t.status === "parked");
    const flagged = allTickets.filter((t) => t.status === "flagged");
    const open = allTickets.filter((t) => t.status === "open" || t.status === "in_progress" || t.status === "in_review");

    // Most recent deployment/PR for this cycle window, now that deploy-agent
    // persists prUrl on the deployments row.
    const [latestDeployment] = await database
      .select()
      .from(deployments)
      .where(gte(deployments.deployedAt, cycle.startedAt))
      .orderBy(desc(deployments.deployedAt))
      .limit(1);
    const prUrl = latestDeployment?.prUrl ?? null;

    // "scan"/"triage" runs never reach release — the last stage they ever
    // touch is their own name, so showing "Release" as the completed badge
    // would be misleading (nothing was released).
    const completedStage: Stage = mode === "full" ? "release" : mode;

    return {
      cycleId,
      mode,
      startedAt,
      endedAt,
      stage: completedStage,
      stageDetail: null,
      loopIterationHint: null,
      counts: await deriveCounts(cycle.startedAt, epicKey, database),
      recentLog: logLines.slice(-20),
      processAlive,
      failed: exitCode !== null && exitCode !== 0,
      exitCode,
      result: {
        fixed: fixed.map((t) => ({ id: t.id, jiraKey: t.jiraKey, category: t.category })),
        parked: parked.map((t) => ({ id: t.id, jiraKey: t.jiraKey, category: t.category })),
        flagged: flagged.map((t) => ({ id: t.id, jiraKey: t.jiraKey, category: t.category })),
        open: open.map((t) => ({ id: t.id, jiraKey: t.jiraKey, category: t.category })),
        prUrl,
      },
      logsByStage: filterLogsByStage(logLines),
    };
  }

  // Still running — derive coarse stage from DB rows + log patterns
  const epicKey = cycle.epicKey;
  const stage = await deriveStageFromDB(cycle.startedAt, epicKey, logLines, database);
  const stageDetail = parseStageDetailFromLog(logLines);
  const counts = await deriveCounts(cycle.startedAt, epicKey, database);
  // Once a merge has happened this cycle, every subsequent deployment marks
  // the start of another fix→review→merge→verify pass — surface that as a
  // "cycle N" hint instead of leaving the timeline looking identical to the
  // first pass (DB-derived, so it survives log truncation unlike a regex).
  const loopIterationHint = mode === "full" && counts.deployments > 0 ? counts.deployments + 1 : null;
  const logsByStage = filterLogsByStage(logLines);

  return {
    cycleId,
    mode,
    startedAt,
    endedAt: null,
    stage,
    stageDetail,
    loopIterationHint,
    counts,
    recentLog: logLines.slice(-20),
    processAlive,
    failed: !processAlive && endedAt === null,
    exitCode,
    result: null,
    logsByStage,
  };
}

async function deriveStageFromDB(startedAt: Date, epicKey: string | null, logLines: string[], database: NonNullable<typeof db>): Promise<Stage> {
  const logStage = inferStageFromLog(logLines);

  const ticketsCount = await database
    .select()
    .from(tickets)
    .where(
      epicKey
        ? or(gte(tickets.createdAt, startedAt), eq(tickets.epicKey, epicKey))
        : gte(tickets.createdAt, startedAt),
    );

  if (ticketsCount.length === 0) {
    return logStage ?? "scan";
  }

  const attemptsCount = await database
    .select()
    .from(fixAttempts)
    .where(
      and(
        inArray(
          fixAttempts.ticketId,
          ticketsCount.map((t) => t.id),
        ),
        gte(fixAttempts.createdAt, startedAt),
      ),
    );

  if (attemptsCount.length === 0) {
    // DB says triage, but logs may show the developer agent already working
    if (logStage && stageOrder(logStage) > stageOrder("triage")) {
      return logStage;
    }
    return logStage ?? "triage";
  }

  const reviewsCount = await database
    .select()
    .from(reviewResults)
    .where(
      and(
        inArray(
          reviewResults.fixAttemptId,
          attemptsCount.map((a) => a.id),
        ),
        gte(reviewResults.createdAt, startedAt),
      ),
    );

  if (reviewsCount.length === 0) {
    if (logStage && stageOrder(logStage) > stageOrder("fix")) {
      return logStage;
    }
    return "fix";
  }

  const deploymentsCount = await database.select().from(deployments).where(gte(deployments.deployedAt, startedAt));

  if (deploymentsCount.length === 0) {
    if (logStage && stageOrder(logStage) > stageOrder("review")) {
      return logStage;
    }
    return "review";
  }

  // A branch has already been merged into qa this cycle — from here on
  // (until the release agent runs) we're in the post-merge verification
  // window: re-scan the live site, re-triage, and confirm which tickets are
  // genuinely fixed (see triage-from-reports.ts's per-ticket verification).
  if (logStage === "release") {
    return "release";
  }
  return "verify";
}

const STAGE_ORDER: Record<Stage, number> = {
  scan: 0, triage: 1, fix: 2, review: 3, autofix: 4, deploy: 5, cleanup: 6, verify: 7, release: 8, unknown: -1,
};

function stageOrder(stage: Stage): number {
  return STAGE_ORDER[stage] ?? -1;
}

async function deriveCounts(startedAt: Date, epicKey: string | null, database: NonNullable<typeof db>) {
  const allTickets = await database.select().from(tickets).where(
    epicKey
      ? or(gte(tickets.createdAt, startedAt), eq(tickets.epicKey, epicKey))
      : gte(tickets.createdAt, startedAt),
  );

  const allAttempts = await database
    .select()
    .from(fixAttempts)
    .where(
      and(
        inArray(
          fixAttempts.ticketId,
          allTickets.map((t) => t.id),
        ),
        gte(fixAttempts.createdAt, startedAt),
      ),
    );

  const allReviews = await database
    .select()
    .from(reviewResults)
    .where(
      and(
        inArray(
          reviewResults.fixAttemptId,
          allAttempts.map((a) => a.id),
        ),
        gte(reviewResults.createdAt, startedAt),
      ),
    );

  const allDeployments = await database.select().from(deployments).where(gte(deployments.deployedAt, startedAt));

  return {
    ticketsOpen: allTickets.filter((t) => t.status === "open").length,
    ticketsInProgress: allTickets.filter((t) => t.status === "in_progress").length,
    ticketsInReview: allTickets.filter((t) => t.status === "in_review").length,
    ticketsParked: allTickets.filter((t) => t.status === "parked").length,
    ticketsFlagged: allTickets.filter((t) => t.status === "flagged").length,
    ticketsDone: allTickets.filter((t) => t.status === "done").length,
    fixAttempts: allAttempts.length,
    reviewsApproved: allReviews.filter((r) => r.verdict === "approved").length,
    reviewsRejected: allReviews.filter((r) => r.verdict === "rejected").length,
    deployments: allDeployments.length,
  };
}

/**
 * Infer stage from log patterns when DB row counts are ambiguous.
 * Returns null if no clear pattern is found.
 */
function inferStageFromLog(lines: string[]): Stage | null {
  // Search backwards (most recent first)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];

    // Fix stage: any [developer] activity
    if (line.includes('[developer]')) {
      return "fix";
    }

    // Fix stage: orchestrator fixing tickets
    if (line.includes('Fixing ticket') || line.includes('prepareBranch')) {
      return "fix";
    }

    // Review stage: [reviewer] activity — includes PR review/changes-requested/fix-agent cycles
    if (
      line.includes('[reviewer]') ||
      line.includes('Reviewing branch') ||
      line.includes('Reviewing PR') ||
      line.includes('Fix Agent addressing review feedback')
    ) {
      return "review";
    }

    // Deploy stage — pushing the batch branch and merging it into qa
    // (direct git merge, no PR — see deploy-agent.ts's deployBranch)
    if (
      line.includes('Pushed branch') ||
      line.includes('Merging branch') ||
      line.includes('Merged') && line.includes('into')
    ) {
      return "deploy";
    }

    // Release stage
    if (line.includes('Running release for cycle')) {
      return "release";
    }

    // Triage stage
    if (line.includes('Running triage from reports') || line.includes('Creating ticket')) {
      return "triage";
    }

    // Scan stage (Playwright/axe activity)
    if (line.includes('Running Playwright') || line.includes('[scan]')) {
      return "scan";
    }
  }

  return null;
}

/**
 * Filter log lines by stage for accordion display.
 */
function filterLogsByStage(lines: string[]): Record<Stage, string[]> {
  const byStage: Record<Stage, string[]> = {
    scan: [],
    triage: [],
    fix: [],
    review: [],
    autofix: [],
    deploy: [],
    cleanup: [],
    verify: [],
    release: [],
    unknown: []
  };

  for (const line of lines) {
    if (line.includes('Running Playwright') || line.includes('axe scan') || line.includes('Scan complete') || line.includes('[scan]')) {
      byStage.scan.push(line);
    } else if (line.includes('Running triage') || line.includes('triage from reports') || line.includes('Creating ticket') || line.includes('[triage]')) {
      byStage.triage.push(line);
    } else if (line.includes('[developer]') || line.includes('Fixing ticket') || line.includes('prepareBranch') || line.includes('Pushed branch') || line.includes('[fix]')) {
      byStage.fix.push(line);
    } else if (line.includes('[reviewer]') || line.includes('Reviewing branch') || line.includes('Reviewing PR') || line.includes('Reviewer verdict') || line.includes('[review]')) {
      byStage.review.push(line);
    } else if (line.includes('Autofixing build errors') || line.includes('Fix Agent addressing review feedback') || line.includes('[autofix]')) {
      byStage.autofix.push(line);
    } else if (line.includes('Merging branch') || (line.includes('Merged') && line.includes('into')) || line.includes('[deploy]')) {
      byStage.deploy.push(line);
    } else if (line.includes('Running release') || line.includes('[release]')) {
      byStage.release.push(line);
    } else if (line.includes('[orchestrate]')) {
      // General orchestrate lines — classify by content. Checked before the
      // generic "branch" match below, since a merge line ("Merging branch
      // X into qa") would otherwise be misclassified as "fix" activity.
      if (line.includes('Merging') || line.includes('merge') || line.includes('deploy')) {
        byStage.deploy.push(line);
      } else if (line.includes('scan') || line.includes('Playwright')) {
        byStage.scan.push(line);
      } else if (line.includes('triage')) {
        byStage.triage.push(line);
      } else if (line.includes('fix') || line.includes('branch')) {
        byStage.fix.push(line);
      } else if (line.includes('review')) {
        byStage.review.push(line);
      } else if (line.includes('release')) {
        byStage.release.push(line);
      } else {
        byStage.unknown.push(line);
      }
    } else {
      byStage.unknown.push(line);
    }
  }

  return byStage;
}

/**
 * Parse the log tail for fine-grained stage detail ("Fixing ticket 3/7").
 *
 * Matches against the literal strings already in src/orchestrator/graph.ts.
 */
function parseStageDetailFromLog(lines: string[]): string | null {
  // Match exact log strings from graph.ts (see plan for line citations)
  const patterns = [
    /Fixing ticket (\d+)\/(\d+): ([\w-]+)/,
    /Running Playwright/,
    /Running triage from reports/,
    /Pushed branch/,
    /Created PR .*/,
    /Reusing existing open PR #(\d+)/,
    /Reviewing branch/,
    /Reviewing PR #(\d+)/,
    /Reviewer verdict/,
    /Autofixing build errors \(retry (\d+)\/(\d+)\)/,
    /Fix Agent addressing review feedback \(retry (\d+)\/(\d+)\)/,
    /Deploying branch/,
    /Merging PR #(\d+)/,
    /Running release for cycle/,
  ];

  for (let i = lines.length - 1; i >= 0; i--) {
    for (const pattern of patterns) {
      const match = lines[i].match(pattern);
      if (match) {
        return match[0]; // return the full matched string
      }
    }
  }

  return null;
}
