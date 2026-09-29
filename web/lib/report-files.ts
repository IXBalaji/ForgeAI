import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AxeReport } from "./run-results";
import { REPORT_DIR_NAME, REPORT_FILE_EXT, REPORT_HTML_FILE } from "./results-constants";

/** Same root resolution as process-runner.ts, plus the A11Y_REPORT_DIR override the orchestrator honours. */
export function resolveReportDir(): string {
  if (process.env.A11Y_REPORT_DIR) return process.env.A11Y_REPORT_DIR;
  const repoRoot = process.env.ORCHESTRATOR_REPO_ROOT || resolve(process.cwd(), "..");
  return join(repoRoot, REPORT_DIR_NAME);
}

/** Reads every per-page-state axe JSON report. A missing directory or unreadable file is skipped, not fatal. */
export async function readAxeReports(): Promise<Array<{ state: string; report: AxeReport }>> {
  const dir = resolveReportDir();
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(REPORT_FILE_EXT));
  } catch {
    return [];
  }

  const reports = await Promise.all(
    files.map(async (file) => {
      try {
        const report = JSON.parse(await readFile(join(dir, file), "utf-8")) as AxeReport;
        return { state: file.slice(0, -REPORT_FILE_EXT.length), report };
      } catch (err) {
        console.warn(`[results] Skipping unreadable report ${file}:`, (err as Error).message);
        return null;
      }
    }),
  );
  return reports.filter((r) => r !== null);
}

export async function readHtmlReport(): Promise<string | null> {
  try {
    return await readFile(join(resolveReportDir(), REPORT_HTML_FILE), "utf-8");
  } catch {
    return null;
  }
}
