import { NextResponse } from "next/server";
import { requireDb } from "@/lib/db";
import { iterationCycles } from "@/lib/schema";
import { desc } from "drizzle-orm";

export async function GET() {
  const db = requireDb();
  const cycles = await db
    .select()
    .from(iterationCycles)
    .orderBy(desc(iterationCycles.startedAt))
    .limit(30);

  return NextResponse.json({
    cycles: cycles.map((c) => ({
      cycleId: c.id,
      mode: c.mode,
      startedAt: c.startedAt.toISOString(),
      endedAt: c.endedAt?.toISOString() ?? null,
    })),
  });
}
