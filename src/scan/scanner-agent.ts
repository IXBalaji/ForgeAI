import "dotenv/config";
import { chromium } from "playwright";
import { traceable } from "langsmith/traceable";
import { db } from "../db/client.js";
import { scanRuns, issues } from "../db/schema.js";
import type { Severity } from "../types/index.js";
import { runAxeScan, fingerprintFinding, type RawFinding } from "./axe-scan.js";
import { runPa11yScan } from "./pa11y-scan.js";
import { runVisionScan } from "./vision-scan.js";

export interface AuthRole {
  label: string;
  credentials?: { email: string; password: string };
  storageState?: string | object;
  routes: string[];
}

export interface ScannerOptions {
  targetEnv: string;
  baseUrl: string;
  routes: string[];
  triggeredBy?: string;
  auth?: {
    loginUrl?: string;
    roles?: AuthRole[];
  };
}

export interface ScannerResult {
  scanRunId: string;
  issueCount: number;
  bySeverity: Record<Severity, number>;
  bySource: Record<RawFinding["source"], number>;
}

async function performLogin(
  baseUrl: string,
  loginUrl: string,
  credentials: { email: string; password: string },
): Promise<object> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const fullLoginUrl = new URL(loginUrl, baseUrl).toString();
    await page.goto(fullLoginUrl, { waitUntil: "networkidle" });
    await page.getByLabel("Work email").fill(credentials.email);
    await page.getByLabel("Password").fill(credentials.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForSelector("h1", { timeout: 15000 });
    return await context.storageState();
  } finally {
    await browser.close();
  }
}

async function resolveStorageState(
  baseUrl: string,
  loginUrl: string | undefined,
  role: AuthRole,
): Promise<object | undefined> {
  if (role.storageState) {
    return typeof role.storageState === "string"
      ? JSON.parse(role.storageState)
      : role.storageState;
  }
  if (role.credentials && loginUrl) {
    return performLogin(baseUrl, loginUrl, role.credentials);
  }
  return undefined;
}

function runAllSources(baseUrl: string, routes: string[], storageState?: object): Array<Promise<RawFinding[]>> {
  const sourceRuns: Array<Promise<RawFinding[]>> = [
    runAxeScan(baseUrl, routes, { storageState }),
  ];
  if (process.env.SCAN_PA11Y !== "false") {
    sourceRuns.push(runPa11yScan(baseUrl, routes, { storageState }));
  }
  if (process.env.SCAN_VISION !== "false") {
    sourceRuns.push(runVisionScan(baseUrl, routes, { storageState }));
  }
  return sourceRuns;
}

/**
 * Scanner agent — runs every configured scan source against the given routes,
 * merges and fingerprints the findings, and writes a ScanRun + Issue rows.
 * Supports multi-role authentication: when auth.roles is provided, each role
 * is logged in and its routes are scanned separately, with all findings
 * merged and deduped by fingerprint.
 */
export const runScannerAgent = traceable(_runScannerAgent, { name: "scanner.run_scan", run_type: "chain" });

async function _runScannerAgent(opts: ScannerOptions): Promise<ScannerResult> {
  const [{ id: scanRunId }] = await db
    .insert(scanRuns)
    .values({
      targetEnv: opts.targetEnv,
      toolVersions: {
        "axe-core": "4.10",
        playwright: "1.49",
        pa11y: process.env.SCAN_PA11Y === "false" ? "disabled" : "8",
        "claude-vision": process.env.SCAN_VISION === "false" ? "disabled" : (process.env.ANTHROPIC_API_KEY ? "enabled" : "no-api-key"),
      },
      triggeredBy: opts.triggeredBy ?? "manual",
    })
    .returning({ id: scanRuns.id });

  const allSourceRuns: Array<Promise<RawFinding[]>> = [];

  if (opts.routes.length > 0) {
    allSourceRuns.push(...runAllSources(opts.baseUrl, opts.routes));
  }

  if (opts.auth?.roles) {
    for (const role of opts.auth.roles) {
      const storageState = await resolveStorageState(opts.baseUrl, opts.auth.loginUrl, role);
      if (role.routes.length > 0) {
        allSourceRuns.push(...runAllSources(opts.baseUrl, role.routes, storageState as object | undefined));
      }
    }
  }

  const settled = await Promise.allSettled(allSourceRuns);
  const allFindings: RawFinding[] = [];
  const bySource: Record<RawFinding["source"], number> = { axe: 0, pa11y: 0, vision: 0 };

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
    if (seenFingerprints.has(fp)) continue;
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
