import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { createHash } from "node:crypto";
import type { Severity } from "../types/index.js";
import { resolveAxeConfig, type ScanRuleConfig } from "./scan-config.js";

/** One raw finding from any scan source, before fingerprinting/DB persistence. */
export interface RawFinding {
  source: "axe" | "pa11y" | "vision";
  wcagRule: string;
  selector: string;
  pageUrl: string;
  severity: Severity;
  screenshotUrl?: string | null;
}

export interface AxeScanOptions {
  tags?: string[];
  storageState?: string | object;
  /** Override the scan config — if not provided, loads from file/env */
  scanConfig?: ScanRuleConfig;
}

export function fingerprintFinding(f: Pick<RawFinding, "wcagRule" | "selector" | "pageUrl">): string {
  return createHash("sha256").update(`${f.wcagRule}::${f.selector}::${f.pageUrl}`).digest("hex");
}

/**
 * Pure axe-core + Playwright scanning primitive — no DB writes, no side
 * effects. Shared by the Scanner agent (full scan) and the Reviewer agent
 * (targeted re-scan of just the touched pages).
 *
 * Rule configuration is driven by the WCAG 2.2 registry in wcag-rules.ts.
 * Rules can be attached/detached via:
 *   - scan-config.json in the project root
 *   - Environment variables (AXE_DISABLE_CRITERIA="1.4.3,2.5.8")
 *   - Programmatic API (attachCriterion/detachCriterion)
 */
export async function runAxeScan(baseUrl: string, routes: string[], options?: AxeScanOptions): Promise<RawFinding[]> {
  const resolved = resolveAxeConfig(options?.scanConfig);
  const tags = options?.tags ?? resolved.tags;
  const findings: RawFinding[] = [];
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext(
      options?.storageState ? { storageState: options.storageState as any } : undefined,
    );
    const page = await context.newPage();
    for (const route of routes) {
      const pageUrl = new URL(route, baseUrl).toString();
      await page.goto(pageUrl, { waitUntil: "networkidle" });

      let builder = new AxeBuilder({ page }).withTags(tags);

      // Attach additional rules from the WCAG registry that axe tags may not cover
      if (resolved.enabledRules.length > 0) {
        builder = builder.withRules(resolved.enabledRules);
      }

      // Detach disabled rules
      if (resolved.disabledRules.length > 0) {
        builder = builder.disableRules(resolved.disabledRules);
      }

      const results = await builder.analyze();

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
