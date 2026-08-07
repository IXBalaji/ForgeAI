import type { RawFinding } from "./axe-scan.js";
import type { Severity } from "../types/index.js";

export interface LighthouseScanOptions {
  storageState?: string | object;
}

function extractCookieHeader(storageState: string | object | undefined): string | undefined {
  if (!storageState) return undefined;
  const state = typeof storageState === "string" ? JSON.parse(storageState) : storageState;
  const cookies = (state as any).cookies;
  if (!Array.isArray(cookies) || cookies.length === 0) return undefined;
  return cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
}

/**
 * Lighthouse's accessibility category is itself powered by a subset of
 * axe-core rules, so this is deliberately a trend-line/scoring source, not a
 * primary rule engine — it will overlap heavily with axe-scan.ts's findings
 * (scanner-agent.ts dedupes by fingerprint), and its per-node detail is
 * coarser than axe-core's direct API. Kept as its own module because the
 * plan calls for Lighthouse's score as a tracked trend line independent of
 * the raw violation count.
 */
export async function runLighthouseScan(baseUrl: string, routes: string[], options?: LighthouseScanOptions): Promise<RawFinding[]> {
  const { default: lighthouse } = await import("lighthouse");
  const chromeLauncher = await import("chrome-launcher");

  const cookieHeader = extractCookieHeader(options?.storageState);
  const extraHeaders: Record<string, string> | undefined = cookieHeader ? { Cookie: cookieHeader } : undefined;

  const findings: RawFinding[] = [];
  const chrome = await chromeLauncher.launch({ chromeFlags: ["--headless"] });
  try {
    for (const route of routes) {
      const pageUrl = new URL(route, baseUrl).toString();
      const runnerResult = await lighthouse(pageUrl, {
        port: chrome.port,
        onlyCategories: ["accessibility"],
        output: "json",
        extraHeaders,
      });
      const lhr = runnerResult?.lhr;
      if (!lhr) continue;

      for (const auditRef of lhr.categories.accessibility?.auditRefs ?? []) {
        const audit = lhr.audits[auditRef.id];
        if (!audit || audit.score === null || audit.score === 1) continue;

        const items = (audit.details as any)?.items ?? [];
        const severity: Severity = "moderate";

        if (items.length === 0) {
          findings.push({
            source: "lighthouse",
            wcagRule: audit.id,
            selector: "(page-level)",
            pageUrl,
            severity,
          });
          continue;
        }

        for (const item of items) {
          findings.push({
            source: "lighthouse",
            wcagRule: audit.id,
            selector: item.node?.selector ?? "(unspecified)",
            pageUrl,
            severity,
          });
        }
      }
    }
  } finally {
    await chrome.kill();
  }
  return findings;
}
