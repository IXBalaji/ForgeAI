import "dotenv/config";
import { db } from "../db/client.js";
import { scanRuns, issues } from "../db/schema.js";
import type { Severity } from "../types/index.js";
import { runAxeScan, fingerprintFinding, type RawFinding } from "./axe-scan.js";
import { runLighthouseScan } from "./lighthouse-scan.js";
import { runPa11yScan } from "./pa11y-scan.js";
import { runVisionScan } from "./vision-scan.js";

export interface ScannerOptions {
  targetEnv: string;
  baseUrl: string;
  routes: string[];
  triggeredBy?: string;
}

export interface ScannerResult {
  scanRunId: string;
  issueCount: number;
  bySeverity: Record<Severity, number>;
  bySource: Record<RawFinding["source"], number>;
}

/**
 * Scanner agent — runs every configured scan source against the given routes,
 * merges and fingerprints the findings, and writes a ScanRun + Issue rows.
 * Idempotent: re-scanning updates an existing Issue's scan_run_id rather than
 * duplicating it (see the fingerprint unique index in db/schema.ts).
 */
export async function runScannerAgent(opts: ScannerOptions): Promise<ScannerResult> {
  const [{ id: scanRunId }] = await db
    .insert(scanRuns)
    .values({
      targetEnv: opts.targetEnv,
      toolVersions: {
        "axe-core": "4.10",
        playwright: "1.49",
        lighthouse: process.env.SCAN_LIGHTHOUSE === "false" ? "disabled" : "12",
        pa11y: process.env.SCAN_PA11Y === "false" ? "disabled" : "8",
        "claude-vision": process.env.SCAN_VISION === "false" ? "disabled" : (process.env.ANTHROPIC_API_KEY ? "enabled" : "no-api-key"),
      },
      triggeredBy: opts.triggeredBy ?? "manual",
    })
    .returning({ id: scanRuns.id });

  // Each source is independent — one failing (e.g. Lighthouse choking on a
  // route) doesn't abort the others. Findings across sources are merged and
  // deduped by fingerprint below, so the same real issue caught by two tools
  // still becomes one Issue row.
  const sourceRuns: Array<Promise<RawFinding[]>> = [runAxeScan(opts.baseUrl, opts.routes)];
  if (process.env.SCAN_LIGHTHOUSE !== "false") sourceRuns.push(runLighthouseScan(opts.baseUrl, opts.routes));
  if (process.env.SCAN_PA11Y !== "false") sourceRuns.push(runPa11yScan(opts.baseUrl, opts.routes));
  if (process.env.SCAN_VISION !== "false") sourceRuns.push(runVisionScan(opts.baseUrl, opts.routes));

  const settled = await Promise.allSettled(sourceRuns);
  const allFindings: RawFinding[] = [];
  const bySource: Record<RawFinding["source"], number> = { axe: 0, lighthouse: 0, pa11y: 0, vision: 0 };

  for (const result of settled) {
    if (result.status === "rejected") {
      console.warn("[scanner] a scan source failed — continuing with the others:", result.reason);
      continue;
    }
    for (const finding of result.value) {
      allFindings.push(finding);
      bySource[finding.source] += 1;
    }
  }

  const bySeverity: Record<Severity, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  const seenFingerprints = new Set<string>();

  for (const finding of allFindings) {
    const fp = fingerprintFinding(finding);
    if (seenFingerprints.has(fp)) continue; // same real issue caught by >1 source
    seenFingerprints.add(fp);

    await db
      .insert(issues)
      .values({
        scanRunId,
        fingerprint: fp,
        wcagRule: finding.wcagRule,
        selector: finding.selector,
        pageUrl: finding.pageUrl,
        severity: finding.severity,
        screenshotUrl: finding.screenshotUrl ?? null,
        status: "open",
      })
      .onConflictDoUpdate({
        target: issues.fingerprint,
        set: { scanRunId, status: "open" },
      });

    bySeverity[finding.severity] += 1;
  }

  const issueCount = Object.values(bySeverity).reduce((a, b) => a + b, 0);
  return { scanRunId, issueCount, bySeverity, bySource };
}
