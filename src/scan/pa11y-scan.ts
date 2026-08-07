import type { RawFinding } from "./axe-scan.js";
import type { Severity } from "../types/index.js";

const PA11Y_TYPE_TO_SEVERITY: Record<string, Severity> = {
  error: "serious",
  warning: "moderate",
  notice: "minor",
};

export interface Pa11yScanOptions {
  storageState?: string | object;
}

function extractCookieHeader(storageState: string | object | undefined): string | undefined {
  if (!storageState) return undefined;
  const state = typeof storageState === "string" ? JSON.parse(storageState) : storageState;
  const cookies = (state as any).cookies;
  if (!Array.isArray(cookies) || cookies.length === 0) return undefined;
  return cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
}

async function findChromePath(): Promise<string> {
  const { getChromePath } = await import("chrome-launcher");
  return getChromePath();
}

/**
 * Pa11y — the secondary ruleset. It uses HTML CodeSniffer's rule set rather
 * than axe-core's, so it genuinely catches a different (if overlapping) set
 * of issues than axe-scan.ts; scanner-agent.ts dedupes overlaps by
 * fingerprint.
 *
 * Known limitation: HTML CodeSniffer crashes on some SPAs (React, etc.) with
 * a .replace() TypeError inside its injected runner. This is a known pa11y 8
 * bug — the per-route try/catch ensures it doesn't break the other scanners.
 */
export async function runPa11yScan(baseUrl: string, routes: string[], options?: Pa11yScanOptions): Promise<RawFinding[]> {
  const { default: pa11y } = await import("pa11y");
  const chromePath = await findChromePath();
  const cookieHeader = extractCookieHeader(options?.storageState);
  const headers: Record<string, string> | undefined = cookieHeader ? { Cookie: cookieHeader } : undefined;
  const findings: RawFinding[] = [];

  for (const route of routes) {
    const pageUrl = new URL(route, baseUrl).toString();
    try {
      const result = await pa11y(pageUrl, {
        timeout: 30000,
        wait: 3000,
        chromeLaunchConfig: { executablePath: chromePath },
        headers,
      });

      for (const issue of result.issues) {
        findings.push({
          source: "pa11y",
          wcagRule: issue.code,
          selector: issue.selector || "(unspecified)",
          pageUrl,
          severity: PA11Y_TYPE_TO_SEVERITY[issue.type] ?? "moderate",
        });
      }
    } catch (err) {
      console.warn(`[pa11y] failed on ${pageUrl} — skipping this route:`, (err as Error).message);
    }
  }
  return findings;
}
