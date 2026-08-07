import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "../lib/exec.js";

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error("Could not determine a free port"));
      }
    });
    server.on("error", reject);
  });
}

async function waitForServer(url: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not up yet — keep polling
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Preview server at ${url} did not become ready within ${timeoutMs}ms`);
}

export interface EphemeralPreview {
  url: string;
  stop: () => Promise<void>;
}

/**
 * Builds and serves the fix branch's own frontend so the Reviewer's re-scan
 * checks the ACTUAL fix, not whatever happens to already be running at
 * TARGET_FRONTEND_URL. This is the gap flagged earlier: without this, the
 * Reviewer's "targeted re-scan" was scanning the shared dev/prod URL
 * regardless of which branch it was supposed to be verifying.
 *
 * Honest tradeoff: a git worktree doesn't carry node_modules (gitignored),
 * so this runs a fresh `npm install` per review — correct, but slower than
 * a warm build. Worth revisiting with a shared node_modules cache if review
 * latency becomes a problem.
 */
export async function startEphemeralPreview(worktreeDir: string): Promise<EphemeralPreview> {
  const frontendDir = join(worktreeDir, "frontend");
  const mainFrontendEnv = join(process.env.TARGET_REPO_PATH ?? "", "frontend", ".env");
  const worktreeFrontendEnv = join(frontendDir, ".env");
  if (existsSync(mainFrontendEnv) && !existsSync(worktreeFrontendEnv)) {
    copyFileSync(mainFrontendEnv, worktreeFrontendEnv);
  }

  await run("npm", ["install"], frontendDir);
  await run("npm", ["run", "build"], frontendDir);

  const port = await getFreePort();
  const child = spawn("npm", ["run", "preview", "--", "--port", String(port), "--strictPort"], {
    cwd: frontendDir,
    shell: true,
    stdio: "ignore",
  });

  const url = `http://localhost:${port}`;
  try {
    await waitForServer(url);
  } catch (err) {
    child.kill();
    throw err;
  }

  return {
    url,
    stop: async () => {
      child.kill();
    },
  };
}
