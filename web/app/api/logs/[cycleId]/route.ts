import { NextResponse } from "next/server";
import { readCycleLog } from "@/lib/log-files";
import { sanitizeLogLine } from "@/lib/sanitize";
import { CYCLE_ID_PATTERN, API_ERROR } from "@/lib/results-constants";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ cycleId: string }> },
) {
  const { cycleId } = await params;
  if (!CYCLE_ID_PATTERN.test(cycleId)) {
    return NextResponse.json({ error: API_ERROR.invalidCycleId }, { status: 400 });
  }

  const content = await readCycleLog(cycleId);
  if (content === null) {
    return NextResponse.json({ error: "Log not found for this cycle" }, { status: 404 });
  }

  const sanitized = content.split("\n").map(sanitizeLogLine).join("\n");
  return new NextResponse(sanitized, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
