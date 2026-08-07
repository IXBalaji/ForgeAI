import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Run a command and capture output. Throws with stdout+stderr attached on non-zero exit. */
export async function run(cmd: string, args: string[], cwd: string): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, maxBuffer: 1024 * 1024 * 32 });
    return { stdout, stderr };
  } catch (err: any) {
    throw new Error(
      `Command failed: ${cmd} ${args.join(" ")}\n${err.stdout ?? ""}\n${err.stderr ?? err.message}`,
    );
  }
}
