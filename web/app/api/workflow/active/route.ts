/**
 * GET /api/workflow/active
 *
 * Check if there's an active workflow run.
 *
 * Returns:
 * - { active: false } if no run is active
 * - { active: true, cycleId, startedAt } if a run is active
 * - { active: "stalled", cycleId, startedAt } if a lock file exists but the process is dead
 */

import { NextResponse } from "next/server";
import { getActiveRun } from "@/lib/run-registry";
import type { ActiveRun } from "@/lib/types";

export async function GET() {
  const activeRun = await getActiveRun();

  if (activeRun.active === false) {
    return NextResponse.json<ActiveRun>({ active: false });
  }

  if (activeRun.active === "stalled") {
    return NextResponse.json<ActiveRun>({
      active: "stalled",
      cycleId: activeRun.cycleId,
      startedAt: activeRun.startedAt,
    });
  }

  return NextResponse.json<ActiveRun>({
    active: true,
    cycleId: activeRun.cycleId,
    startedAt: activeRun.startedAt,
  });
}
