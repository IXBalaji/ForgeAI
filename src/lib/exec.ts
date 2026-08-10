import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Run a command and capture output. Throws with stdout+stderr attached on non-zero exit. */
export async function run(cmd: string, args: string[], cwd: string): Promise<ExecResult> {
  // Node's spawn throws the identical ENOENT for "executable not found" and
  // "cwd does not exist" — checking this up front turns a misleading
  // PATH-shaped error into the actual problem (usually a wrong env var).
  if (!existsSync(cwd)) {
    throw new Error(`cwd "${cwd}" does not exist — check TARGET_REPO_PATH (or the worktree dir) in .env.`);
  }
  const useShell = process.platform === "win32" && /^(npm|npx|pnpm|yarn)$/i.test(cmd);
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, maxBuffer: 1024 * 1024 * 32, shell: useShell });
    return { stdout, stderr };
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new Error(
        `"${cmd}" is not on PATH for this process — run \`${cmd} --version\` in the same shell/context that launched this command to confirm.`,
      );
    }
    const stdout = (err.stdout ?? "").trim();
    const stderr = (err.stderr ?? "").trim();
    throw new Error(
      `Command failed: ${cmd} ${args.join(" ")}\n${stdout}\n${stderr || err.message}`,
    );
  }
}
