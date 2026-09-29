/**
 * GET /api/workflow/[cycleId]/report
 *
 * Serves the latest generated a11y-reports/index.html (the full per-page axe
 * report). The file is overwritten by every scan, so it reflects the most
 * recent run — which is the run the results view links from.
 */

import { NextResponse } from "next/server";
import { readHtmlReport } from "@/lib/report-files";
import { API_ERROR, CYCLE_ID_PATTERN } from "@/lib/results-constants";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ cycleId: string }> },
) {
  const { cycleId } = await params;
  if (!CYCLE_ID_PATTERN.test(cycleId)) {
    return NextResponse.json({ error: API_ERROR.invalidCycleId }, { status: 400 });
  }

  const html = await readHtmlReport();
  if (html === null) {
    return NextResponse.json({ error: API_ERROR.reportNotFound }, { status: 404 });
  }
  return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
