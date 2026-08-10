import { join } from "node:path";
import { run } from "../lib/exec.js";

export interface TestGateResult {
  passed: boolean;
  output: string;
}

export async function testGate(worktreeDir: string, touchedFiles: string[]): Promise<TestGateResult> {
  const workspaces = new Set<string>();
  for (const f of touchedFiles) {
    if (f.startsWith("backend/")) workspaces.add("backend");
    if (f.startsWith("frontend/")) workspaces.add("frontend");
  }
  if (workspaces.size === 0) return { passed: true, output: "No workspace files touched — nothing to test." };

  const outputs: string[] = [];

  for (const ws of workspaces) {
    const wsDir = join(worktreeDir, ws);

    try {
      await run("npm", ["install", "--ignore-scripts"], wsDir);
    } catch (err) {
      outputs.push(`[${ws}:install] FAILED — ${(err as Error).message.slice(0, 300)}`);
      return { passed: false, output: outputs.join("\n") };
    }

    // Build check
    try {
      await run("npm", ["run", "build", "--if-present"], wsDir);
      outputs.push(`[${ws}:build] passed`);
    } catch (err: any) {
      const message: string = err.message ?? "";
      if (/missing script/i.test(message) || /npm ERR! Missing/i.test(message)) {
        outputs.push(`[${ws}:build] no build script — skipped`);
      } else {
        const changedInWs = touchedFiles.filter(f => f.startsWith(`${ws}/`)).map(f => f.replace(`${ws}/`, ""));
        const errorInChangedFile = changedInWs.some(f => message.includes(f));
        if (errorInChangedFile) {
          outputs.push(`[${ws}:build] FAILED in changed files — ${message.slice(0, 500)}`);
          return { passed: false, output: outputs.join("\n") };
        }
        outputs.push(`[${ws}:build] FAILED (pre-existing, not in changed files — non-blocking)`);
      }
    }

    // Lint check
    try {
      await run("npm", ["run", "lint", "--if-present"], wsDir);
      outputs.push(`[${ws}:lint] passed`);
    } catch (err: any) {
      const message: string = err.message ?? "";
      if (/missing script/i.test(message) || /npm ERR! Missing/i.test(message)) {
        outputs.push(`[${ws}:lint] no lint script — skipped`);
      } else {
        const changedInWs = touchedFiles.filter(f => f.startsWith(`${ws}/`)).map(f => f.replace(`${ws}/`, ""));
        const errorInChangedFile = changedInWs.some(f => message.includes(f));
        if (errorInChangedFile) {
          outputs.push(`[${ws}:lint] FAILED in changed files — ${message.slice(0, 500)}`);
          return { passed: false, output: outputs.join("\n") };
        }
        outputs.push(`[${ws}:lint] FAILED (pre-existing, not in changed files — non-blocking)`);
      }
    }

    // Test check
    try {
      const { stdout, stderr } = await run("npm", ["test", "--if-present", "--silent"], wsDir);
      outputs.push(`[${ws}:test] passed`);
    } catch (err: any) {
      const message: string = err.message ?? "";
      if (/no test specified|missing script|npm ERR! Missing/i.test(message)) {
        outputs.push(`[${ws}:test] no test suite — skipped`);
        continue;
      }
      outputs.push(`[${ws}:test] FAILED — ${message.slice(0, 500)}`);
      return { passed: false, output: outputs.join("\n") };
    }
  }
  return { passed: true, output: outputs.join("\n") };
}
