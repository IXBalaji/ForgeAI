/**
 * GET /api/workflow/[cycleId]/results
 *
 * Read-only results for the unified results view:
 * - scan: aggregated axe violations from this run's a11y-reports/*.json
 * - tickets: this run's tickets joined with issues, fix attempts and reviews
 *   (null for scan-only runs, which create no tickets)
 *
 * Returns 200 RunResults, 400 for a malformed cycleId, 404 if the cycle doesn't exist.
 */

import { NextResponse } from "next/server";
import { and, eq, gte, inArray } from "drizzle-orm";
import { requireDb } from "@/lib/db";
import { iterationCycles, tickets, issues, fixAttempts, reviewResults } from "@/lib/schema";
import { cycleTicketsCondition } from "@/lib/run-status";
import { readAxeReports } from "@/lib/report-files";
import { buildScanResults, buildTicketRows } from "@/lib/run-results";
import { API_ERROR, CYCLE_ID_PATTERN, RUN_MODE } from "@/lib/results-constants";
import type { RunMode, RunResults, TicketRow } from "@/lib/types";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ cycleId: string }> },
) {
  const { cycleId } = await params;
  if (!CYCLE_ID_PATTERN.test(cycleId)) {
    return NextResponse.json({ error: API_ERROR.invalidCycleId }, { status: 400 });
  }

  try {
    const database = requireDb();
    const [cycle] = await database.select().from(iterationCycles).where(eq(iterationCycles.id, cycleId));
    if (!cycle) {
      return NextResponse.json({ error: API_ERROR.cycleNotFound, cycleId }, { status: 404 });
    }

    const mode = (cycle.mode as RunMode | undefined) ?? RUN_MODE.full;
    const scan = buildScanResults(await readAxeReports(), { startedAt: cycle.startedAt, endedAt: cycle.endedAt });

    let ticketRows: TicketRow[] | null = null;
    if (mode !== RUN_MODE.scan) {
      const cycleTickets = await database.select().from(tickets).where(cycleTicketsCondition(cycle.startedAt, cycle.epicKey));
      const ticketIds = cycleTickets.map((t) => t.id);
      const issueIds = [...new Set(cycleTickets.flatMap((t) => (Array.isArray(t.issueIds) ? (t.issueIds as string[]) : [])))];

      const ticketIssues = issueIds.length
        ? await database
            .select({ id: issues.id, severity: issues.severity, pageUrl: issues.pageUrl })
            .from(issues)
            .where(inArray(issues.id, issueIds))
        : [];
      const attempts = ticketIds.length
        ? await database
            .select({ id: fixAttempts.id, ticketId: fixAttempts.ticketId, prUrl: fixAttempts.prUrl, createdAt: fixAttempts.createdAt })
            .from(fixAttempts)
            .where(and(inArray(fixAttempts.ticketId, ticketIds), gte(fixAttempts.createdAt, cycle.startedAt)))
        : [];
      const reviews = attempts.length
        ? await database
            .select({ fixAttemptId: reviewResults.fixAttemptId, verdict: reviewResults.verdict, createdAt: reviewResults.createdAt })
            .from(reviewResults)
            .where(inArray(reviewResults.fixAttemptId, attempts.map((a) => a.id)))
        : [];

      ticketRows = buildTicketRows({
        tickets: cycleTickets,
        issues: ticketIssues,
        attempts,
        reviews,
        startedAt: cycle.startedAt,
        jiraBaseUrl: process.env.JIRA_BASE_URL,
      });
    }

    return NextResponse.json<RunResults>({ mode, scan, tickets: ticketRows });
  } catch (err: unknown) {
    console.error(`[results] Error loading results for ${cycleId}:`, err);
    return NextResponse.json(
      { error: API_ERROR.resultsFailed, details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
