import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { redactSecrets } from "../observability/sanitize.js";

export type LogLevel = "info" | "warn" | "error";

interface LoggerContext {
  cycleId: string;
}

const storage = new AsyncLocalStorage<LoggerContext>();

const LOGGER_ROOT = join(process.cwd(), "logger");
const STARTUP_LOG_FILE = join(
  LOGGER_ROOT,
  `startup-${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
);

/**
 * Runs `fn` with `cycleId` attached to every logger call made anywhere
 * inside it (including nested async calls), the same AsyncLocalStorage
 * pattern src/observability/pipeline-context.ts already uses — no function
 * signature in the pipeline needs to thread cycleId through to log.
 */
export function runWithCycleLogger<T>(cycleId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ cycleId }, fn);
}

function currentLogFile(): string {
  const ctx = storage.getStore();
  if (ctx) return join(LOGGER_ROOT, ctx.cycleId, "cycle.log");
  return STARTUP_LOG_FILE;
}

function writeLine(level: LogLevel, moduleName: string, message: string, error?: unknown): void {
  const filePath = currentLogFile();
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString();
  const safeMessage = redactSecrets(message);
  const fileLines = [`[${timestamp}] [${level.toUpperCase()}] [${moduleName}] ${safeMessage}`];
  if (error instanceof Error) {
    fileLines.push(redactSecrets(error.stack ?? error.message).split("\n").map((l) => `    ${l}`).join("\n"));
  } else if (error !== undefined) {
    fileLines.push(`    ${redactSecrets(String(error))}`);
  }
  appendFileSync(filePath, fileLines.join("\n") + "\n", "utf-8");

  const consoleMessage = `[${moduleName}] ${safeMessage}`;
  const consoleErrArg = error instanceof Error ? redactSecrets(error.message) : error !== undefined ? redactSecrets(String(error)) : undefined;
  const consoleArgs = error !== undefined ? [consoleMessage, consoleErrArg] : [consoleMessage];
  if (level === "error") console.error(...consoleArgs);
  else if (level === "warn") console.warn(...consoleArgs);
  else console.log(...consoleArgs);
}

export const logger = {
  info(moduleName: string, message: string): void {
    writeLine("info", moduleName, message);
  },
  warn(moduleName: string, message: string, error?: unknown): void {
    writeLine("warn", moduleName, message, error);
  },
  error(moduleName: string, message: string, error?: unknown): void {
    writeLine("error", moduleName, message, error);
  },
};
