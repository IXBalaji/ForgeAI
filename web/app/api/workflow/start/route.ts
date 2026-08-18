/**
 * POST /api/workflow/start
 *
 * Start a new orchestrator run.
 *
 * Guards:
 * - Check for an existing active run (DB + lock file)
 * - Pre-insert the iteration_cycles row
 * - Spawn the orchestrator as a detached child process
 *
 * Returns:
 * - 202 { cycleId, pid, startedAt } on success
 * - 409 { error: "already_running" | "stalled", cycleId, startedAt } if blocked
 */

import { NextResponse } from "next/server";
import { db, requireDb } from "@/lib/db";
import { iterationCycles } from "@/lib/schema";
import { eq, isNull } from "drizzle-orm";
import { getActiveRun, clearActiveRun, registerActiveRun } from "@/lib/run-registry";
import { spawnOrchestrator, spawnTestCommand } from "@/lib/process-runner";
import { dispatchOrchestratorWorkflow, isDispatchConfigured } from "@/lib/github-dispatch";
import type { StartResponse, ConflictResponse } from "@/lib/types";

export async function POST(request: Request) {
  if (!db) {
    return NextResponse.json(
      { error: "DATABASE_URL is required (web/.env.local locally, or a Vercel env var when deployed)" },
      { status: 503 },
    );
  }

  const database = requireDb();
  // Check for an existing active run (lock file)
  const activeRun = await getActiveRun();

  if (activeRun.active === true) {
    return NextResponse.json<ConflictResponse>(
      {
        error: "already_running",
        cycleId: activeRun.cycleId,
        startedAt: activeRun.startedAt,
      },
      { status: 409 },
    );
  }

  // Auto-recover stalled runs: process is dead, clean up lock file and mark DB row as ended
  if (activeRun.active === "stalled") {
    console.log(
      `[start] Auto-recovering stalled run: cycleId=${activeRun.cycleId}`,
    );
    await clearActiveRun(activeRun.cycleId);
    await database
      .update(iterationCycles)
      .set({ endedAt: new Date() })
      .where(eq(iterationCycles.id, activeRun.cycleId));
  }

  // Check for orphaned DB rows (ended_at IS NULL but no live process)
  const [existingCycle] = await database
    .select()
    .from(iterationCycles)
    .where(isNull(iterationCycles.endedAt))
    .limit(1);

  if (existingCycle) {
    // The lock-file check already passed (no live process), so this is an orphan — close it
    console.log(
      `[start] Auto-closing orphaned cycle: id=${existingCycle.id}`,
    );
    await db
      .update(iterationCycles)
      .set({ endedAt: new Date() })
      .where(eq(iterationCycles.id, existingCycle.id));
  }

  // Pre-insert the iteration_cycles row
  const [cycle] = await database
    .insert(iterationCycles)
    .values({
      cycleNumber: 0,
      openIssueCount: 0,
    })
    .returning();

  if (!cycle) {
    return NextResponse.json(
      { error: "Failed to create iteration_cycles row" },
      { status: 500 },
    );
  }

  // Three ways to actually kick off the run:
  // - Deployed (GH_ACTIONS_PAT set): dispatch .github/workflows/orchestrate.yml,
  //   which runs on its own GitHub-hosted machine — no local process to spawn
  // - Local dev, ?test=true: harmless fake progress, for exercising the UI
  // - Local dev, default: spawn the real orchestrator as a child process
  const url = new URL(request.url);
  const useTestCommand = url.searchParams.get("test") === "true";

  let pid: number | null = null;

  try {
    if (isDispatchConfigured()) {
      await dispatchOrchestratorWorkflow(cycle.id);
      // No local process to track — registerActiveRun() no-ops when
      // GH-dispatch is configured (see run-registry.ts's usesDbLiveness);
      // the DB row's endedAt is the liveness signal instead.
      await registerActiveRun({ cycleId: cycle.id, pid: 0, startedAt: cycle.startedAt.toISOString() });
    } else if (useTestCommand && process.env.NODE_ENV !== "production") {
      pid = await spawnTestCommand(cycle.id);
    } else {
      pid = await spawnOrchestrator(cycle.id);
    }
  } catch (err: unknown) {
    console.error("[start] Failed to start orchestrator:", err);
    // Clean up the pre-inserted cycle row so it doesn't become an orphan
    await database
      .update(iterationCycles)
      .set({ endedAt: new Date() })
      .where(eq(iterationCycles.id, cycle.id));
    await clearActiveRun(cycle.id);
    return NextResponse.json(
      {
        error: "Failed to start orchestrator",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }

  return NextResponse.json<StartResponse>(
    {
      cycleId: cycle.id,
      pid,
      startedAt: cycle.startedAt.toISOString(),
    },
    { status: 202 },
  );
}
