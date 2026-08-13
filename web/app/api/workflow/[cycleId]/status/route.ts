/**
 * GET /api/workflow/[cycleId]/status
 *
 * Get the status of a specific workflow run.
 *
 * Combines:
 * - DB row counts (authoritative "confirmed so far")
 * - Log tail regex (best-effort "what's happening right now")
 *
 * Returns:
 * - 200 { cycleId, startedAt, endedAt, stage, stageDetail, counts, recentLog, processAlive, failed, exitCode, result }
 * - 404 if the cycleId doesn't exist
 */

import { NextResponse } from "next/server";
import { deriveRunStatus } from "@/lib/run-status";
import { readLogTail, getActiveRun } from "@/lib/run-registry";
import { sanitizeLogLines } from "@/lib/sanitize";
import type { RunStatus } from "@/lib/types";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ cycleId: string }> },
) {
  const { cycleId } = await params;

  // Validate cycleId format to prevent path traversal
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(cycleId)) {
    return NextResponse.json(
      { error: "Invalid cycleId format" },
      { status: 400 },
    );
  }

  // Read the log tail
  const rawLogLines = await readLogTail(cycleId, 200);
  const sanitizedLogLines = sanitizeLogLines(rawLogLines);

  // Check if the process is alive
  const activeRun = await getActiveRun();
  const processAlive =
    activeRun.active === true && activeRun.cycleId === cycleId;

  // Exit code: null if process is alive, 0 if completed successfully, non-zero if failed
  // For now, we don't have a way to capture the actual exit code, so we'll infer it
  // from the DB (endedAt) and process liveness
  const exitCode: number | null = processAlive ? null : 0;

  try {
    const status: RunStatus = await deriveRunStatus(
      cycleId,
      sanitizedLogLines,
      processAlive,
      exitCode,
    );

    return NextResponse.json<RunStatus>(status);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("No iteration_cycles row")) {
      return NextResponse.json(
        { error: "Cycle not found", cycleId },
        { status: 404 },
      );
    }

    console.error(`[status] Error deriving status for ${cycleId}:`, err);
    return NextResponse.json(
      {
        error: "Failed to derive status",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
