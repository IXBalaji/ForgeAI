import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { createHash } from "node:crypto";
import type { Severity } from "../types/index.js";

/** One raw finding from any scan source, before fingerprinting/DB persistence. */
export interface RawFinding {
  source: "axe" | "lighthouse" | "pa11y" | "vision";
  wcagRule: string;
  selector: string;
  pageUrl: string;
  severity: Severity;
  screenshotUrl?: string | null;
}

export function fingerprintFinding(f: Pick<RawFinding, "wcagRule" | "selector" | "pageUrl">): string {
  return createHash("sha256").update(`${f.wcagRule}::${f.selector}::${f.pageUrl}`).digest("hex");
}

/**
 * Pure axe-core + Playwright scanning primitive — no DB writes, no side
 * effects. Shared by the Scanner agent (full scan) and the Reviewer agent
 * (targeted re-scan of just the touched pages) so the Reviewer never has to
 * go through the Scanner's ScanRun-writing pipeline just to check a few
 * routes — see review/reviewer-agent.ts for why that mattered.
 */
export async function runAxeScan(baseUrl: string, routes: string[]): Promise<RawFinding[]> {
  const findings: RawFinding[] = [];
  const browser = await chromium.launch();
  try {
    // @axe-core/playwright's finishRun() step opens a second blank page
    // internally to combine partial results — it needs an explicit
    // browser.newContext() to do that, and throws if the page came from
    // the browser.newPage() shorthand instead.
    const context = await browser.newContext();
    const page = await context.newPage();
    for (const route of routes) {
      const pageUrl = new URL(route, baseUrl).toString();
      await page.goto(pageUrl, { waitUntil: "networkidle" });
      const results = await new AxeBuilder({ page }).analyze();

      for (const violation of results.violations) {
        const severity = (violation.impact ?? "moderate") as Severity;
        for (const node of violation.nodes) {
          findings.push({
            source: "axe",
            wcagRule: violation.id,
            selector: node.target.join(" "),
            pageUrl,
            severity,
            screenshotUrl: null,
          });
        }
      }
    }
  } finally {
    await browser.close();
  }
  return findings;
}
