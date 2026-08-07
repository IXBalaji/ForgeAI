import { join } from "node:path";
import { run } from "../lib/exec.js";

export interface TestGateResult {
  passed: boolean;
  output: string;
}

/**
 * Runs whichever workspace's test suite the diff touched. Treats an
 * unconfigured ("no test specified") placeholder script as a skip, not a
 * failure — don't let the gate block forever on a workspace that has no
 * tests yet (true of this target repo today — see README's honesty note).
 */
export async function testGate(worktreeDir: string, touchedFiles: string[]): Promise<TestGateResult> {
  const workspaces = new Set<string>();
  for (const f of touchedFiles) {
    if (f.startsWith("backend/")) workspaces.add("backend");
    if (f.startsWith("frontend/")) workspaces.add("frontend");
  }
  if (workspaces.size === 0) return { passed: true, output: "No workspace files touched — nothing to test." };

  const outputs: string[] = [];
  for (const ws of workspaces) {
    try {
      const { stdout, stderr } = await run("npm", ["test", "--silent"], join(worktreeDir, ws));
      outputs.push(`[${ws}] ${stdout}${stderr}`);
    } catch (err: any) {
      const message: string = err.message ?? "";
      if (/no test specified/i.test(message)) {
        outputs.push(`[${ws}] no test suite configured — gate skipped for this workspace.`);
        continue;
      }
      return { passed: false, output: outputs.concat(message).join("\n") };
    }
  }
  return { passed: true, output: outputs.join("\n") };
}
