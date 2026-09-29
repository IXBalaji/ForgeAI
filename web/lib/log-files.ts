import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Same root resolution as process-runner.ts/report-files.ts. */
export function resolveLoggerDir(): string {
  const repoRoot = process.env.ORCHESTRATOR_REPO_ROOT || resolve(process.cwd(), "..");
  return join(repoRoot, "logger");
}

export async function readCycleLog(cycleId: string): Promise<string | null> {
  try {
    return await readFile(join(resolveLoggerDir(), cycleId, "cycle.log"), "utf-8");
  } catch {
    return null;
  }
}
