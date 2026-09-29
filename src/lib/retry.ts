import { logger } from "./logger.js";

export interface RetryOptions {
  retries: number;
  delayMs: number;
  backoff?: "fixed" | "exponential";
  isRetryable?: (err: unknown) => boolean;
  label: string;
}

/**
 * Shared retry-with-backoff helper. Consolidates the bespoke retry loops that
 * used to be duplicated across graph.ts (pushBranchNode, autofixNode's copy of
 * the same push loop, removeWorktreeWithRetry) — now backs those plus Jira,
 * GitHub PR-lifecycle, and email calls.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const { retries, delayMs, backoff = "fixed", isRetryable = () => true, label } = opts;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const canRetry = attempt < retries && isRetryable(err);
      const msg = err instanceof Error ? err.message.slice(0, 200) : String(err);
      if (!canRetry) {
        logger.error("retry", `${label} failed after ${attempt}/${retries} attempt(s).`, msg);
        throw err;
      }
      const wait = backoff === "exponential" ? delayMs * 2 ** (attempt - 1) : delayMs;
      logger.warn("retry", `${label} attempt ${attempt}/${retries} failed, retrying in ${wait / 1000}s...`, msg);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
