/**
 * In-memory + on-disk registry tracking active runs, PIDs, and lock files.
 *
 * The lock file closes the race window between spawning and the first DB write,
 * and lets liveness be checked by PID.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { isNull } from "drizzle-orm";
import { db } from "./db";
import { iterationCycles } from "./schema";

const RUN_DIR = join(process.cwd(), ".run");
const LOCK_FILE = join(RUN_DIR, "active.lock");

// On Vercel there's no shared filesystem between the dashboard and the
// GitHub Actions runner that actually executes the orchestrator — PID/lock
// files are meaningless there. Fall back to the DB row's endedAt as the
// liveness signal instead.
const usesDbLiveness = Boolean(process.env.VERCEL);

export interface ActiveRunRecord {
  cycleId: string;
  pid: number;
  startedAt: string;
}

// In-memory cache — survives within a single Next.js process, reset on restart
const activeRunCache = new Map<string, ActiveRunRecord>();

/**
 * Ensure the .run directory exists.
 */
async function ensureRunDir(): Promise<void> {
  await fs.mkdir(RUN_DIR, { recursive: true });
}

/**
 * Check if a process is alive by PID.
 *
 * On Windows, process.kill(pid, 0) throws if the process doesn't exist.
 * On POSIX, it returns without error if the process exists.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "ESRCH") {
      return false; // process not found
    }
    if (err && typeof err === "object" && "code" in err && err.code === "EPERM") {
      return true; // process exists but we lack permission to signal it
    }
    return false;
  }
}

/**
 * Register a new active run — write the lock file and cache in memory.
 */
export async function registerActiveRun(record: ActiveRunRecord): Promise<void> {
  if (usesDbLiveness) return; // no local process/disk to track — DB is the source of truth
  await ensureRunDir();
  await fs.writeFile(LOCK_FILE, JSON.stringify(record, null, 2), "utf-8");
  activeRunCache.set(record.cycleId, record);
}

/**
 * Clear the active run — remove the lock file and clear the cache.
 */
export async function clearActiveRun(cycleId: string): Promise<void> {
  if (usesDbLiveness) return;
  await ensureRunDir();
  try {
    await fs.unlink(LOCK_FILE);
  } catch (err: unknown) {
    // Ignore ENOENT — lock file already gone
    if (err && typeof err === "object" && "code" in err && err.code !== "ENOENT") {
      throw err;
    }
  }
  activeRunCache.delete(cycleId);
}

/**
 * Get the active run record, if any.
 *
 * Returns { active: false } if no run is active.
 * Returns { active: true, ...record } if a run is active and the process is alive.
 * Returns { active: "stalled", ...record } if a lock file exists but the process is dead.
 */
export async function getActiveRun(): Promise<
  | { active: false }
  | ({ active: true } & ActiveRunRecord)
  | ({ active: "stalled" } & ActiveRunRecord)
> {
  if (usesDbLiveness) {
    // Known gap: an Actions run that crashes without the orchestrator ever
    // setting endedAt looks identical to one still legitimately running —
    // there's no PID to detect as dead. Revisit via the GitHub Actions run
    // status API if stalled runs turn out to happen in practice.
    if (!db) return { active: false };
    const [openCycle] = await db
      .select()
      .from(iterationCycles)
      .where(isNull(iterationCycles.endedAt))
      .limit(1);
    if (!openCycle) return { active: false };
    // No PID exists for a run dispatched to GitHub Actions — 0 is a sentinel,
    // never a real PID, so isProcessAlive-style checks elsewhere don't apply.
    return { active: true, cycleId: openCycle.id, pid: 0, startedAt: openCycle.startedAt.toISOString() };
  }

  await ensureRunDir();

  // Check in-memory cache first
  if (activeRunCache.size > 0) {
    const [record] = [...activeRunCache.values()];
    if (isProcessAlive(record.pid)) {
      return { active: true, ...record };
    } else {
      // Process died — clear cache and fall through to disk check
      activeRunCache.clear();
    }
  }

  // Check lock file on disk
  try {
    const contents = await fs.readFile(LOCK_FILE, "utf-8");
    const record = JSON.parse(contents) as ActiveRunRecord;

    if (isProcessAlive(record.pid)) {
      activeRunCache.set(record.cycleId, record);
      return { active: true, ...record };
    } else {
      // Stalled — lock file exists but process is dead
      return { active: "stalled", ...record };
    }
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return { active: false };
    }
    throw err;
  }
}

/**
 * Get the log file path for a given cycle ID.
 *
 * Validates cycleId to prevent path traversal attacks.
 */
export function getLogFilePath(cycleId: string): string {
  // Strict validation: only alphanumeric, hyphens, and underscores
  // This matches the UUID format generated by the database
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(cycleId)) {
    throw new Error("Invalid cycleId format");
  }

  return join(RUN_DIR, `${cycleId}.log`);
}

/**
 * Read the tail of a log file (last N lines), sanitized.
 *
 * Returns empty array if the file doesn't exist.
 */
export async function readLogTail(cycleId: string, maxLines = 20): Promise<string[]> {
  const logPath = getLogFilePath(cycleId);

  try {
    const contents = await fs.readFile(logPath, "utf-8");
    const lines = contents.split("\n").filter((line) => line.trim().length > 0);
    return lines.slice(-maxLines);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}
