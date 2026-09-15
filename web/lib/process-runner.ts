/**
 * Spawn the orchestrator as a detached child process with stdout/stderr piped
 * to a per-run log file.
 *
 * Windows-specific considerations:
 * - detached: true + child.unref() allows the child to survive parent exit
 * - stdio: ['ignore', logStream, logStream] pipes output without blocking parent
 * - The child must be spawned with the same Node.js executable as the parent
 */

import { spawn, type ChildProcess } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { registerActiveRun, clearActiveRun, getLogFilePath } from "./run-registry";

/**
 * Spawn the orchestrator for a given cycle ID.
 *
 * Returns the PID of the spawned child process.
 */
export async function spawnOrchestrator(cycleId: string, mode: "scan" | "triage" | "full" = "full"): Promise<number> {
  const repoRoot =
    process.env.ORCHESTRATOR_REPO_ROOT || resolve(process.cwd(), "..");
  const cliPath = join(repoRoot, "src", "cli", "index.ts");
  const logPath = getLogFilePath(cycleId);

  // Open a file descriptor for stdout/stderr (Windows-compatible)
  const logFd = openSync(logPath, "a");

  // Spawn the child process
  // - Use tsx to run TypeScript directly (same approach as npm run pipeline)
  // - Pass --cycle-id so the orchestrator reuses our pre-inserted row (which
  //   already carries the requested mode — --mode is passed too for CLI
  //   parity, but the DB row is the source of truth once it exists)
  // - detached: true + unref() lets it survive parent exit on Windows
  const child: ChildProcess = spawn(
    process.execPath,
    [
      join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      cliPath,
      "orchestrate",
      "--cycle-id",
      cycleId,
      "--mode",
      mode,
    ],
    {
      cwd: repoRoot,
      stdio: ["ignore", logFd, logFd],
      detached: true,
      env: {
        ...process.env,
        // Ensure the child can find .env at the repo root
        NODE_ENV: process.env.NODE_ENV || "development",
      },
    },
  );

  // Close the parent's copy of the fd — the child now owns it
  closeSync(logFd);

  if (!child.pid) {
    throw new Error("Failed to spawn orchestrator — no PID returned");
  }

  const pid = child.pid;
  const startedAt = new Date().toISOString();

  // Register the active run (lock file + in-memory cache)
  await registerActiveRun({ cycleId, pid, startedAt });

  // Set up exit handler to clear the lock file when the child exits
  child.on("exit", async (code, signal) => {
    console.log(
      `[process-runner] Orchestrator exited: code=${code}, signal=${signal}`,
    );
    await clearActiveRun(cycleId);
  });

  child.on("error", async (err) => {
    console.error(`[process-runner] Orchestrator spawn error:`, err);
    await clearActiveRun(cycleId);
  });

  // Unref so the child can survive parent exit
  child.unref();

  return pid;
}

/**
 * Spawn a harmless test command for verification purposes.
 *
 * Only callable when NODE_ENV !== 'production'.
 * Returns the PID of the spawned test process.
 */
export async function spawnTestCommand(cycleId: string): Promise<number> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("spawnTestCommand is not available in production");
  }

  const logPath = getLogFilePath(cycleId);
  const logFd = openSync(logPath, "a");

  // Spawn a harmless test command that outputs [orchestrate] lines and sleeps
  const child: ChildProcess = spawn(
    process.execPath,
    [
      "-e",
      `
      console.log('[orchestrate] Test workflow starting');
      console.log('[orchestrate] Running Playwright');
      setTimeout(() => {
        console.log('[orchestrate] Running triage from reports');
        setTimeout(() => {
          console.log('[orchestrate] Fixing ticket 1/3: TEST-123');
          setTimeout(() => {
            console.log('[orchestrate] Test workflow complete');
            process.exit(0);
          }, 2000);
        }, 2000);
      }, 2000);
    `.trim(),
    ],
    {
      stdio: ["ignore", logFd, logFd],
      detached: true,
    },
  );

  // Close the parent's copy of the fd
  closeSync(logFd);

  if (!child.pid) {
    throw new Error("Failed to spawn test command — no PID returned");
  }

  const pid = child.pid;
  const startedAt = new Date().toISOString();

  await registerActiveRun({ cycleId, pid, startedAt });

  child.on("exit", async (code, signal) => {
    console.log(`[process-runner] Test command exited: code=${code}, signal=${signal}`);
    await clearActiveRun(cycleId);
  });

  child.on("error", async (err) => {
    console.error(`[process-runner] Test command spawn error:`, err);
    await clearActiveRun(cycleId);
  });

  child.unref();

  return pid;
}
