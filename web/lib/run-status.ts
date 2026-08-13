import { db } from "./db";
import { iterationCycles, tickets, fixAttempts, reviewResults, deployments } from "./schema";
import { eq, gte, and, inArray } from "drizzle-orm";
import type { RunStatus, Stage } from "./types";

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
  const [cycle] = await db.select().from(iterationCycles).where(eq(iterationCycles.id, cycleId));

  if (!cycle) {
    throw new Error(`No iteration_cycles row found for ${cycleId}`);
  }

  const startedAt = cycle.startedAt.toISOString();
  const endedAt = cycle.endedAt?.toISOString() ?? null;

  // If the cycle is complete, surface the results
  if (endedAt) {
    const allTickets = await db
      .select()
      .from(tickets)
      .where(gte(tickets.createdAt, cycle.startedAt));

    const fixed = allTickets.filter((t) => t.status === "done");
    const parked = allTickets.filter((t) => t.status === "parked");
    const flagged = allTickets.filter((t) => t.status === "flagged");

    // prUrl: per the plan, release-agent.ts currently hardcodes this to null,
    // so we won't find one here — surface it as null, not as an error.
    const prUrl = null;

    return {
      cycleId,
      startedAt,
      endedAt,
      stage: "release",
      stageDetail: null,
      loopIterationHint: null,
      counts: await deriveCounts(cycle.startedAt),
      recentLog: logLines.slice(-20),
      processAlive,
      failed: exitCode !== null && exitCode !== 0,
      exitCode,
      result: {
        fixed: fixed.map((t) => ({ id: t.id, jiraKey: t.jiraKey, category: t.category })),
        parked: parked.map((t) => ({ id: t.id, jiraKey: t.jiraKey, category: t.category })),
        flagged: flagged.map((t) => ({ id: t.id, jiraKey: t.jiraKey, category: t.category })),
        prUrl,
      },
      logsByStage: filterLogsByStage(logLines),
    };
  }

  // Still running — derive coarse stage from DB rows + log patterns
  const stage = await deriveStageFromDB(cycle.startedAt, logLines);
  const stageDetail = parseStageDetailFromLog(logLines);
  const loopIterationHint = parseLoopIterationFromLog(logLines);
  const logsByStage = filterLogsByStage(logLines);

  return {
    cycleId,
    startedAt,
    endedAt: null,
    stage,
    stageDetail,
    loopIterationHint,
    counts: await deriveCounts(cycle.startedAt),
    recentLog: logLines.slice(-20),
    processAlive,
    failed: !processAlive && endedAt === null,
    exitCode,
    result: null,
    logsByStage,
  };
}

async function deriveStageFromDB(startedAt: Date, logLines: string[]): Promise<Stage> {
  const logStage = inferStageFromLog(logLines);

  const ticketsCount = await db
    .select()
    .from(tickets)
    .where(gte(tickets.createdAt, startedAt));

  if (ticketsCount.length === 0) {
    return logStage ?? "scan";
  }

  const attemptsCount = await db
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

  const reviewsCount = await db
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

  const deploymentsCount = await db.select().from(deployments).where(gte(deployments.deployedAt, startedAt));

  if (deploymentsCount.length === 0) {
    if (logStage && stageOrder(logStage) > stageOrder("review")) {
      return logStage;
    }
    return "review";
  }

  return logStage ?? "deploy";
}

const STAGE_ORDER: Record<Stage, number> = {
  scan: 0, triage: 1, fix: 2, review: 3, autofix: 4, deploy: 5, cleanup: 6, release: 7, unknown: -1,
};

function stageOrder(stage: Stage): number {
  return STAGE_ORDER[stage] ?? -1;
}

async function deriveCounts(startedAt: Date) {
  const allTickets = await db.select().from(tickets).where(gte(tickets.createdAt, startedAt));

  const allAttempts = await db
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

  const allReviews = await db
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

  const allDeployments = await db.select().from(deployments).where(gte(deployments.deployedAt, startedAt));

  return {
    ticketsOpen: allTickets.filter((t) => t.status === "open").length,
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

    // Review stage: [reviewer] activity
    if (line.includes('[reviewer]') || line.includes('Reviewing branch')) {
      return "review";
    }

    // Deploy stage
    if (line.includes('Deploying branch') || line.includes('Pushed branch')) {
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
    } else if (line.includes('[reviewer]') || line.includes('Reviewing branch') || line.includes('Reviewer verdict') || line.includes('[review]')) {
      byStage.review.push(line);
    } else if (line.includes('Autofixing build errors') || line.includes('[autofix]')) {
      byStage.autofix.push(line);
    } else if (line.includes('Deploying branch') || line.includes('deploy') || line.includes('[deploy]')) {
      byStage.deploy.push(line);
    } else if (line.includes('Running release') || line.includes('[release]')) {
      byStage.release.push(line);
    } else if (line.includes('[orchestrate]')) {
      // General orchestrate lines — classify by content
      if (line.includes('scan') || line.includes('Playwright')) {
        byStage.scan.push(line);
      } else if (line.includes('triage')) {
        byStage.triage.push(line);
      } else if (line.includes('fix') || line.includes('branch')) {
        byStage.fix.push(line);
      } else if (line.includes('review')) {
        byStage.review.push(line);
      } else if (line.includes('deploy')) {
        byStage.deploy.push(line);
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
    /Reviewing branch/,
    /Reviewer verdict/,
    /Autofixing build errors \(retry (\d+)\/(\d+)\)/,
    /Deploying branch/,
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

/**
 * Best-effort loop iteration count from log parsing.
 *
 * graph.ts's internal cycleNumber is NOT persisted, so this is the only way to
 * surface "iteration 2 of 20" — or null if not found.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function parseLoopIterationFromLog(_lines: string[]): number | null {
  // The setPipelineCycleNumber call happens in scanNode after each scan,
  // but the actual value isn't logged as literal text anywhere.
  // We could parse "Waiting Ns for CI/CD..." lines which only appear on
  // cycleNumber > 0, but that's fragile. For v1, return null.
  return null;
}
