import type { RawFinding } from "./axe-scan.js";
import type { Severity } from "../types/index.js";

const PA11Y_TYPE_TO_SEVERITY: Record<string, Severity> = {
  error: "serious",
  warning: "moderate",
  notice: "minor",
};

/**
 * Pa11y — the secondary ruleset. It uses HTML CodeSniffer's rule set rather
 * than axe-core's, so it genuinely catches a different (if overlapping) set
 * of issues than axe-scan.ts; scanner-agent.ts dedupes overlaps by
 * fingerprint.
 */
export async function runPa11yScan(baseUrl: string, routes: string[]): Promise<RawFinding[]> {
  const { default: pa11y } = await import("pa11y");
  const findings: RawFinding[] = [];

  for (const route of routes) {
    const pageUrl = new URL(route, baseUrl).toString();
    // `wait` gives client-rendered SPA pages (React, in this target app's case)
    // time to finish hydrating before pa11y's runner evaluates the DOM —
    // without it, pa11y's injected runner can crash reading properties (e.g.
    // document.title) that don't exist yet mid-render.
    const result = await pa11y(pageUrl, { timeout: 30000, wait: 1500 });

    for (const issue of result.issues) {
      findings.push({
        source: "pa11y",
        wcagRule: issue.code,
        selector: issue.selector || "(unspecified)",
        pageUrl,
        severity: PA11Y_TYPE_TO_SEVERITY[issue.type] ?? "moderate",
      });
    }
  }
  return findings;
}
