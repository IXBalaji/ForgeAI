# Exception Handling & Per-Cycle Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every one of the six failure scenarios (missing config, internal error, expired Jira token, dirty/unsynced git branch, PR-creation failure, per-agent failure) a clear, typed error and a guaranteed cycle-close instead of today's mix of silent swallow, ad hoc `console.*`, and a few genuinely uncaught crashes — plus a `logger/{cycleId}/cycle.log` per orchestrator run and a new web dashboard screen to read it.

**Architecture:** A single ALS-backed logger (mirrors the existing `pipeline-context.ts` pattern) replaces `console.*` everywhere in `src/`. A `validateConfig()` preflight, typed Jira/GitHub auth errors, a git-precondition check, and a `ReleaseError` wrapper around PR creation each throw a distinct error type. `_runOrchestratorCycle` gets one `try/catch/finally` that categorizes any escaping error, writes a fixed `CYCLE_FAILED: <category> | <reason>` sentinel line, and unconditionally sets `iteration_cycles.endedAt`. The web app parses that sentinel out of the log it already tails, and gets a new read-only logs screen backed by the new `logger/` folder.

**Tech Stack:** TypeScript (ESM, `tsx`), Node `AsyncLocalStorage`, Drizzle/Postgres, LangGraph, Next.js App Router, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-exception-handling-and-logging-design.md`

## Global Constraints

- No DB schema changes — reuse the existing `iteration_cycles.endedAt` column; do not add new columns or migrations.
- No changes to Slack/email alerting in `src/lib/notify.ts` — its existing 3 call sites are untouched.
- No changes to `web/lib/process-runner.ts`'s existing stdout-to-`.run/{cycleId}.log` piping — the new `logger/{cycleId}/cycle.log` is additional, not a replacement.
- Logger writes plain human-readable text lines: `[ISO timestamp] [LEVEL] [module] message` (file) and keeps today's `[module] message` shape on the console echo, so nothing that regex-scrapes console/`.run` output breaks.
- New logger root directory is `logger/` at repo root (sibling to `src/`), gitignored.
- Test runner is Vitest (`npm test` = `vitest run`) in both the root project and `web/`; follow this codebase's existing `vi.mock(...)` + dynamic-`import()` test conventions (see `src/lib/repo-config.test.ts`, `src/integrations/tracker/jira.test.ts`, `src/orchestrator/graph.test.ts`).

## Review Focus

- Jira/GitHub `429` (rate-limit) responses must not be misclassified as an auth failure — only `401`/`403` map to the auth-specific typed error. Pinned in Task 3/4.
- Preflight must report **every** missing variable in one error, not stop at the first. Pinned in Task 2.
- A crash whose error type isn't one of the known typed errors (e.g. a raw DB error) must still close the cycle (`endedAt` set) and be categorized `internal` rather than left unclassified. Pinned in Task 7.
- The `CYCLE_FAILED` sentinel parser must pick the real (last) sentinel line, not an earlier decoy line that happens to contain similar text (e.g. quoted inside another error's message). Pinned in Task 9.
- `git status --porcelain` returning only blank/whitespace output must count as a clean tree, not falsely trigger `GitNotCleanError`. Pinned in Task 5.

---

### Task 1: Shared logger module

**Files:**
- Create: `src/lib/logger.ts`
- Test: `src/lib/logger.test.ts`

**Interfaces:**
- Produces: `logger.info(moduleName: string, message: string): void`, `logger.warn(moduleName: string, message: string, error?: unknown): void`, `logger.error(moduleName: string, message: string, error?: unknown): void`, `runWithCycleLogger<T>(cycleId: string, fn: () => Promise<T>): Promise<T>`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/logger.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const appendFileSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const existsSyncMock = vi.fn().mockReturnValue(true);

vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
  appendFileSync: (...args: unknown[]) => appendFileSyncMock(...args),
}));

describe("logger", () => {
  beforeEach(() => {
    appendFileSyncMock.mockReset();
    mkdirSyncMock.mockReset();
    existsSyncMock.mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes to the startup log when no cycle context is active", async () => {
    const { logger } = await import("./logger.js");
    logger.info("preflight", "checking config");

    expect(appendFileSyncMock).toHaveBeenCalledTimes(1);
    const [filePath, content] = appendFileSyncMock.mock.calls[0];
    expect(filePath).toMatch(/logger[\\/]startup-.*\.log$/);
    expect(content).toContain("[INFO] [preflight] checking config");
  });

  it("writes to logger/{cycleId}/cycle.log inside a cycle context", async () => {
    const { logger, runWithCycleLogger } = await import("./logger.js");
    await runWithCycleLogger("cycle-123", async () => {
      logger.warn("orchestrator", "something odd happened");
    });

    const [filePath, content] = appendFileSyncMock.mock.calls[0];
    expect(filePath).toMatch(/logger[\\/]cycle-123[\\/]cycle\.log$/);
    expect(content).toContain("[WARN] [orchestrator] something odd happened");
  });

  it("includes the error stack in the file when an Error is passed", async () => {
    const { logger, runWithCycleLogger } = await import("./logger.js");
    await runWithCycleLogger("cycle-err", async () => {
      logger.error("release", "PR creation failed", new Error("boom"));
    });

    const [, content] = appendFileSyncMock.mock.calls[0];
    expect(content).toContain("[ERROR] [release] PR creation failed");
    expect(content).toContain("boom");
  });

  it("still echoes to console with today's [module] message shape", async () => {
    const { logger } = await import("./logger.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.info("triage", "classified 4 issues");
    expect(logSpy).toHaveBeenCalledWith("[triage] classified 4 issues");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/logger.test.ts`
Expected: FAIL — `Cannot find module './logger.js'`

- [ ] **Step 3: Implement the logger**

```ts
// src/lib/logger.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
  const fileLines = [`[${timestamp}] [${level.toUpperCase()}] [${moduleName}] ${message}`];
  if (error instanceof Error) {
    fileLines.push((error.stack ?? error.message).split("\n").map((l) => `    ${l}`).join("\n"));
  } else if (error !== undefined) {
    fileLines.push(`    ${String(error)}`);
  }
  appendFileSync(filePath, fileLines.join("\n") + "\n", "utf-8");

  const consoleMessage = `[${moduleName}] ${message}`;
  const consoleErrArg = error instanceof Error ? error.message : error;
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/lib/logger.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Add `logger/` to `.gitignore` and commit**

Modify `.gitignore` — add a line `logger/` (next to the existing `.run/`-style runtime-output entries such as `reports/`).

```bash
git add src/lib/logger.ts src/lib/logger.test.ts .gitignore
git commit -m "feat: add shared per-cycle file logger"
```

---

### Task 2: Config preflight validation

**Files:**
- Create: `src/lib/preflight.ts`
- Test: `src/lib/preflight.test.ts`

**Interfaces:**
- Consumes: `logger` from `src/lib/logger.ts` (Task 1).
- Produces: `validateConfig(requirements?: { db?: boolean; repo?: boolean; jira?: boolean; github?: boolean }): void` (throws `ConfigError`), `class ConfigError extends Error { problems: string[] }`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/preflight.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const existsSyncMock = vi.fn().mockReturnValue(true);
vi.mock("node:fs", () => ({ existsSync: (...args: unknown[]) => existsSyncMock(...args) }));

const loggerErrorMock = vi.fn();
vi.mock("./logger.js", () => ({ logger: { error: loggerErrorMock, warn: vi.fn(), info: vi.fn() } }));

describe("validateConfig", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    existsSyncMock.mockReset().mockReturnValue(true);
    loggerErrorMock.mockReset();
    process.env = { ...ORIGINAL_ENV };
    process.env.PROJECT_KEY = "TEST";
    process.env.DATABASE_URL = "postgres://x";
    process.env.TARGET_REPO_PATH = "/repo";
    process.env.JIRA_BASE_URL = "https://x.atlassian.net";
    process.env.JIRA_EMAIL = "a@b.com";
    process.env.JIRA_API_TOKEN = "tok";
    process.env.GITHUB_TOKEN = "gh";
    process.env.GITHUB_OWNER = "acme";
    process.env.GITHUB_REPO = "repo";
  });

  it("passes when every variable required by the given requirements is set", async () => {
    const { validateConfig } = await import("./preflight.js");
    expect(() => validateConfig({ db: true, repo: true, jira: true, github: true })).not.toThrow();
  });

  it("collects every missing variable in one error instead of failing on the first", async () => {
    delete process.env.JIRA_API_TOKEN;
    delete process.env.GITHUB_TOKEN;
    const { validateConfig, ConfigError } = await import("./preflight.js");

    let caught: unknown;
    try {
      validateConfig({ jira: true, github: true });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as InstanceType<typeof ConfigError>).problems).toEqual([
      "JIRA_API_TOKEN is not set.",
      "GITHUB_TOKEN is not set.",
    ]);
  });

  it("does not require jira/github vars when those requirements are not requested", async () => {
    delete process.env.JIRA_API_TOKEN;
    delete process.env.GITHUB_TOKEN;
    const { validateConfig } = await import("./preflight.js");
    expect(() => validateConfig({ db: true, repo: true })).not.toThrow();
  });

  it("flags a TARGET_REPO_PATH that does not exist on disk", async () => {
    existsSyncMock.mockReturnValue(false);
    const { validateConfig, ConfigError } = await import("./preflight.js");
    expect(() => validateConfig({ repo: true })).toThrow(ConfigError);
  });

  it("always requires PROJECT_KEY regardless of requirements", async () => {
    delete process.env.PROJECT_KEY;
    const { validateConfig, ConfigError } = await import("./preflight.js");
    let caught: unknown;
    try {
      validateConfig({});
    } catch (err) {
      caught = err;
    }
    expect((caught as InstanceType<typeof ConfigError>).problems[0]).toContain("PROJECT_KEY");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/preflight.test.ts`
Expected: FAIL — `Cannot find module './preflight.js'`

- [ ] **Step 3: Implement preflight**

```ts
// src/lib/preflight.ts
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "./logger.js";

export interface ConfigRequirements {
  db?: boolean;
  repo?: boolean;
  jira?: boolean;
  github?: boolean;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Configuration is incomplete:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/**
 * Collects every configuration problem for the given requirements in one
 * pass — rather than throwing on the first missing variable — so whoever
 * is running this sees the complete list of what to fix at once.
 */
export function validateConfig(requirements: ConfigRequirements = {}): void {
  const problems: string[] = [];

  if (!process.env.PROJECT_KEY?.trim()) {
    problems.push('PROJECT_KEY is not set — e.g. PROJECT_KEY="ELMS". Set it in .env.');
  }

  if (requirements.db && !process.env.DATABASE_URL?.trim()) {
    problems.push("DATABASE_URL is not set — set it in .env to a valid Postgres connection string.");
  }

  if (requirements.repo) {
    const repoPath = process.env.TARGET_REPO_PATH?.trim();
    if (!repoPath) {
      problems.push("TARGET_REPO_PATH is not set. Add it to .env and point it at the repository root.");
    } else if (!existsSync(repoPath)) {
      problems.push(`TARGET_REPO_PATH is set to "${repoPath}", but that directory does not exist.`);
    } else if (!existsSync(resolve(repoPath, ".git"))) {
      problems.push(`TARGET_REPO_PATH is set to "${repoPath}", but it is not a Git repository.`);
    }
  }

  if (requirements.jira) {
    if (!process.env.JIRA_BASE_URL?.trim()) problems.push("JIRA_BASE_URL is not set.");
    if (!process.env.JIRA_EMAIL?.trim()) problems.push("JIRA_EMAIL is not set.");
    if (!process.env.JIRA_API_TOKEN?.trim()) problems.push("JIRA_API_TOKEN is not set.");
  }

  if (requirements.github) {
    if (!process.env.GITHUB_TOKEN?.trim()) problems.push("GITHUB_TOKEN is not set.");
    if (!process.env.GITHUB_OWNER?.trim()) problems.push("GITHUB_OWNER is not set.");
    if (!process.env.GITHUB_REPO?.trim()) problems.push("GITHUB_REPO is not set.");
  }

  if (problems.length > 0) {
    const error = new ConfigError(problems);
    logger.error("preflight", "Configuration validation failed", error);
    throw error;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/lib/preflight.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/preflight.ts src/lib/preflight.test.ts
git commit -m "feat: add config preflight validation"
```

---

### Task 3: Typed Jira auth/API errors

**Files:**
- Create: `src/integrations/tracker/errors.ts`
- Test: `src/integrations/tracker/errors.test.ts`
- Modify: `src/integrations/tracker/jira.ts:41-55` (the `jiraFetch` method)
- Modify: `src/integrations/tracker/jira.test.ts` (add new cases)

**Interfaces:**
- Produces: `class JiraAuthError extends Error`, `class JiraApiError extends Error`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/integrations/tracker/errors.test.ts
import { describe, expect, it } from "vitest";
import { JiraAuthError, JiraApiError } from "./errors.js";

describe("tracker errors", () => {
  it("JiraAuthError produces an actionable message naming the env var to fix", () => {
    const err = new JiraAuthError(401, "/rest/api/3/issue/PROJ-1");
    expect(err.message).toContain("invalid or expired");
    expect(err.message).toContain("JIRA_API_TOKEN");
  });

  it("JiraApiError includes the status and response body", () => {
    const err = new JiraApiError(400, "POST", "/rest/api/3/issue", "Bad request body");
    expect(err.message).toContain("400");
    expect(err.message).toContain("Bad request body");
  });
});
```

Add to `src/integrations/tracker/jira.test.ts` (inside the existing `describe("JiraAdapter.transitionTicket", ...)` block, after the two existing `it(...)` cases):

```ts
  it("throws JiraAuthError (not a generic error) on a 401 response", async () => {
    const { JiraAdapter } = await import("./jira.js");
    const { JiraAuthError } = await import("./errors.js");
    const adapter = new JiraAdapter();

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    } as Response);

    await expect(adapter.transitionTicket("PROJ-1", "In Progress")).rejects.toThrow(JiraAuthError);
  });

  it("throws JiraApiError (not JiraAuthError) on a 429 rate-limit response", async () => {
    const { JiraAdapter } = await import("./jira.js");
    const { JiraApiError, JiraAuthError } = await import("./errors.js");
    const adapter = new JiraAdapter();

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => "Too Many Requests",
    } as Response);

    await expect(adapter.transitionTicket("PROJ-1", "In Progress")).rejects.toThrow(JiraApiError);
    await expect(adapter.transitionTicket("PROJ-1", "In Progress")).rejects.not.toThrow(JiraAuthError);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/integrations/tracker/errors.test.ts src/integrations/tracker/jira.test.ts`
Expected: FAIL — `Cannot find module './errors.js'`

- [ ] **Step 3: Implement the typed errors and wire them into `jiraFetch`**

```ts
// src/integrations/tracker/errors.ts
export class JiraAuthError extends Error {
  constructor(status: number, path: string) {
    super(`Jira API token is invalid or expired (HTTP ${status} on ${path}). Update JIRA_API_TOKEN and retry.`);
    this.name = "JiraAuthError";
  }
}

export class JiraApiError extends Error {
  constructor(status: number, method: string, path: string, body: string) {
    super(`Jira API ${method} ${path} failed: ${status} ${body}`);
    this.name = "JiraApiError";
  }
}
```

In `src/integrations/tracker/jira.ts`, add the import (near the top, with the other relative imports):

```ts
import { JiraAuthError, JiraApiError } from "./errors.js";
```

Replace the `jiraFetch` method body (current lines 41-55):

```ts
  private async jiraFetch(path: string, init: RequestInit): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new JiraAuthError(res.status, path);
      }
      throw new JiraApiError(res.status, init.method ?? "GET", path, await res.text());
    }
    if (res.status === 204) return null;
    return res.json();
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/integrations/tracker/errors.test.ts src/integrations/tracker/jira.test.ts`
Expected: PASS (all cases, including the 2 pre-existing `jira.test.ts` cases and the 2 new ones)

- [ ] **Step 5: Commit**

```bash
git add src/integrations/tracker/errors.ts src/integrations/tracker/errors.test.ts src/integrations/tracker/jira.ts src/integrations/tracker/jira.test.ts
git commit -m "feat: throw typed JiraAuthError/JiraApiError instead of a generic Error"
```

---

### Task 4: Typed GitHub auth/API errors

**Files:**
- Create: `src/integrations/vcs/errors.ts`
- Test: `src/integrations/vcs/errors.test.ts`
- Modify: `src/integrations/vcs/github.ts:45-60` (the `ghFetch` method)

**Interfaces:**
- Produces: `class GitHubAuthError extends Error`, `class GitHubApiError extends Error`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/integrations/vcs/errors.test.ts
import { describe, expect, it } from "vitest";
import { GitHubAuthError, GitHubApiError } from "./errors.js";

describe("vcs errors", () => {
  it("GitHubAuthError produces an actionable message naming the env var to fix", () => {
    const err = new GitHubAuthError(401, "/user");
    expect(err.message).toContain("invalid or expired");
    expect(err.message).toContain("GITHUB_TOKEN");
  });

  it("GitHubApiError includes the status and response body", () => {
    const err = new GitHubApiError(422, "POST", "/repos/acme/widgets/pulls", "Validation Failed");
    expect(err.message).toContain("422");
    expect(err.message).toContain("Validation Failed");
  });
});
```

```ts
// src/integrations/vcs/github.test.ts — add this describe block at the end of the file
describe("GitHubAdapter — typed error classification", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("throws GitHubAuthError (not GitHubApiError) on a 401 response", async () => {
    process.env.GITHUB_TOKEN = "tok";
    process.env.GITHUB_OWNER = "acme";
    process.env.GITHUB_REPO = "widgets";
    // @ts-expect-error cache-busting query string forces a fresh module instance; not a real resolvable path for tsc
    const { GitHubAdapter } = await import("./github.js?autherr1");
    const { GitHubAuthError } = await import("./errors.js");
    const adapter = new GitHubAdapter();

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Bad credentials",
    } as Response);

    await expect(adapter.createTag("v1", "sha1")).rejects.toThrow(GitHubAuthError);
  });

  it("throws GitHubApiError (not GitHubAuthError) on a 422 response", async () => {
    process.env.GITHUB_TOKEN = "tok";
    process.env.GITHUB_OWNER = "acme";
    process.env.GITHUB_REPO = "widgets";
    // @ts-expect-error cache-busting query string forces a fresh module instance; not a real resolvable path for tsc
    const { GitHubAdapter } = await import("./github.js?apierr1");
    const { GitHubApiError, GitHubAuthError } = await import("./errors.js");
    const adapter = new GitHubAdapter();

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: async () => "Validation Failed",
    } as Response);

    await expect(adapter.createTag("v1", "sha1")).rejects.toThrow(GitHubApiError);
    await expect(adapter.createTag("v1", "sha1")).rejects.not.toThrow(GitHubAuthError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/integrations/vcs/errors.test.ts src/integrations/vcs/github.test.ts`
Expected: FAIL — `Cannot find module './errors.js'`

- [ ] **Step 3: Implement the typed errors and wire them into `ghFetch`**

```ts
// src/integrations/vcs/errors.ts
export class GitHubAuthError extends Error {
  constructor(status: number, path: string) {
    super(`GitHub token is invalid or expired (HTTP ${status} on ${path}). Update GITHUB_TOKEN and retry.`);
    this.name = "GitHubAuthError";
  }
}

export class GitHubApiError extends Error {
  constructor(status: number, method: string, path: string, body: string) {
    super(`GitHub API ${method} ${path} failed: ${status} ${body}`);
    this.name = "GitHubApiError";
  }
}
```

In `src/integrations/vcs/github.ts`, add the import:

```ts
import { GitHubAuthError, GitHubApiError } from "./errors.js";
```

Replace the `ghFetch` method body (current lines 45-60):

```ts
  private async ghFetch(path: string, init: RequestInit = {}): Promise<any> {
    const res = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new GitHubAuthError(res.status, path);
      }
      throw new GitHubApiError(res.status, init.method ?? "GET", path, await res.text());
    }
    if (res.status === 204) return null;
    return res.json();
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/integrations/vcs/errors.test.ts src/integrations/vcs/github.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/integrations/vcs/errors.ts src/integrations/vcs/errors.test.ts src/integrations/vcs/github.ts src/integrations/vcs/github.test.ts
git commit -m "feat: throw typed GitHubAuthError/GitHubApiError instead of a generic Error"
```

---

### Task 5: Git precondition checks (clean tree, in sync with origin)

**Files:**
- Modify: `src/lib/repo-config.ts`
- Modify: `src/lib/repo-config.test.ts` (add new cases)

**Interfaces:**
- Consumes: `run` from `src/lib/exec.ts` (existing).
- Produces: `assertRepoReadyForCycle(repoPath?: string): Promise<void>`, `class GitNotCleanError extends Error`, `class GitNotSyncedError extends Error`.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/repo-config.test.ts` (new `describe` block, after the existing one):

```ts
describe("assertRepoReadyForCycle", () => {
  beforeEach(() => {
    runMock.mockReset();
    process.env.TARGET_REPO_PATH = "C:/repo";
  });

  it("throws GitNotCleanError when the working tree has uncommitted changes", async () => {
    runMock.mockResolvedValueOnce({ stdout: " M src/foo.ts\n?? bar.txt\n", stderr: "" });
    const { assertRepoReadyForCycle, GitNotCleanError } = await import("./repo-config.js");
    await expect(assertRepoReadyForCycle("C:/repo")).rejects.toThrow(GitNotCleanError);
  });

  it("treats blank/whitespace-only porcelain output as a clean tree", async () => {
    runMock
      .mockResolvedValueOnce({ stdout: "  \n\n", stderr: "" }) // status --porcelain
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // fetch
      .mockResolvedValueOnce({ stdout: "0\t0\n", stderr: "" }); // rev-list ahead/behind
    const { assertRepoReadyForCycle } = await import("./repo-config.js");
    await expect(assertRepoReadyForCycle("C:/repo")).resolves.toBeUndefined();
  });

  it("throws GitNotSyncedError when the branch is behind origin", async () => {
    runMock
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "0\t2\n", stderr: "" }); // 0 ahead, 2 behind
    const { assertRepoReadyForCycle, GitNotSyncedError } = await import("./repo-config.js");
    await expect(assertRepoReadyForCycle("C:/repo")).rejects.toThrow(GitNotSyncedError);
  });

  it("throws GitNotSyncedError when the branch has unpushed commits ahead of origin", async () => {
    runMock
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "3\t0\n", stderr: "" }); // 3 ahead, 0 behind
    const { assertRepoReadyForCycle, GitNotSyncedError } = await import("./repo-config.js");
    await expect(assertRepoReadyForCycle("C:/repo")).rejects.toThrow(GitNotSyncedError);
  });

  it("fetches origin before comparing ahead/behind counts", async () => {
    runMock
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "0\t0\n", stderr: "" });
    const { assertRepoReadyForCycle } = await import("./repo-config.js");
    await assertRepoReadyForCycle("C:/repo");
    expect(runMock).toHaveBeenCalledWith("git", ["fetch", "origin", "qa"], "C:/repo");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/repo-config.test.ts`
Expected: FAIL — `assertRepoReadyForCycle is not a function`

- [ ] **Step 3: Implement the precondition check**

Append to `src/lib/repo-config.ts` (after the existing `ensureFreshQaBase` function):

```ts
export class GitNotCleanError extends Error {
  constructor(dirtyFiles: string[]) {
    super(`Working tree is not clean — commit, stash, or discard changes before running:\n${dirtyFiles.map((f) => `  ${f}`).join("\n")}`);
    this.name = "GitNotCleanError";
  }
}

export class GitNotSyncedError extends Error {
  constructor(branch: string, direction: "behind" | "ahead") {
    super(
      direction === "behind"
        ? `Branch "${branch}" is behind origin/${branch} — pull the latest changes before running.`
        : `Branch "${branch}" has unpushed commits ahead of origin/${branch} — push before running.`,
    );
    this.name = "GitNotSyncedError";
  }
}

/**
 * Confirms the target repo is safe to start a new cycle on: no uncommitted
 * changes, and the base branch is neither behind nor ahead of origin.
 */
export async function assertRepoReadyForCycle(repoPath = assertTargetRepoConfigured()): Promise<void> {
  const { stdout: statusOut } = await run("git", ["status", "--porcelain"], repoPath);
  const dirtyFiles = statusOut.split("\n").map((l) => l.trim()).filter(Boolean);
  if (dirtyFiles.length > 0) {
    throw new GitNotCleanError(dirtyFiles);
  }

  const branch = process.env.GITHUB_QA_BRANCH ?? "qa";
  await run("git", ["fetch", "origin", branch], repoPath);
  const { stdout: countsOut } = await run(
    "git",
    ["rev-list", "--left-right", "--count", `${branch}...origin/${branch}`],
    repoPath,
  );
  const [aheadStr, behindStr] = countsOut.trim().split(/\s+/);
  const ahead = parseInt(aheadStr ?? "0", 10);
  const behind = parseInt(behindStr ?? "0", 10);
  if (behind > 0) throw new GitNotSyncedError(branch, "behind");
  if (ahead > 0) throw new GitNotSyncedError(branch, "ahead");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/lib/repo-config.test.ts`
Expected: PASS (7 tests total: 2 pre-existing + 5 new)

- [ ] **Step 5: Commit**

```bash
git add src/lib/repo-config.ts src/lib/repo-config.test.ts
git commit -m "feat: add git precondition check (clean tree, in sync with origin)"
```

---

### Task 6: PR-creation error handling in the release agent

**Files:**
- Modify: `src/release/release-agent.ts:72-99`
- Create: `src/release/release-agent.test.ts`

**Interfaces:**
- Produces: `class ReleaseError extends Error`, `createReleasePr(vcs: VcsProvider, head: string, base: string, title: string, body: string): Promise<{ number: number; htmlUrl: string } | null>` (exported for direct testing).

- [ ] **Step 1: Write the failing tests**

```ts
// src/release/release-agent.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("dotenv/config", () => ({}));
vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../db/schema.js", () => ({
  tickets: {}, iterationCycles: {}, fixAttempts: {}, reviewResults: {}, deployments: {}, reportsGenerated: {},
}));
vi.mock("../lib/notify.js", () => ({ notifySlack: vi.fn() }));
vi.mock("../lib/audit-log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../integrations/email.js", () => ({ sendEmail: vi.fn() }));
vi.mock("../integrations/report-template.js", () => ({
  renderPostProcessEmailHtml: vi.fn(),
  renderPostProcessEmailText: vi.fn(),
}));
vi.mock("./final-report.js", () => ({ generateFinalReport: vi.fn() }));
vi.mock("../lib/config.js", () => ({ LABEL_PREFIX: "TEST" }));
vi.mock("../integrations/vcs/factory.js", () => ({ getVcsProvider: () => ({ createPullRequest: vi.fn() }) }));

describe("createReleasePr", () => {
  it("wraps a createPullRequest rejection in a ReleaseError with a clear message", async () => {
    const { createReleasePr, ReleaseError } = await import("./release-agent.js");
    const vcs = { createPullRequest: vi.fn().mockRejectedValue(new Error("422 Validation Failed")) } as any;

    await expect(createReleasePr(vcs, "qa", "main", "title", "body")).rejects.toThrow(ReleaseError);
    await expect(createReleasePr(vcs, "qa", "main", "title", "body")).rejects.toThrow(/Pull request could not be created/);
  });

  it("returns the PR ref on success", async () => {
    const { createReleasePr } = await import("./release-agent.js");
    const vcs = { createPullRequest: vi.fn().mockResolvedValue({ number: 5, htmlUrl: "https://x/5" }) } as any;
    const result = await createReleasePr(vcs, "qa", "main", "title", "body");
    expect(result).toEqual({ number: 5, htmlUrl: "https://x/5" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/release/release-agent.test.ts`
Expected: FAIL — `createReleasePr is not a function`

- [ ] **Step 3: Implement `ReleaseError` and `createReleasePr`, and use it in `runReleaseAgent`**

Add near the top of `src/release/release-agent.ts`, after the imports:

```ts
export class ReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseError";
  }
}

async function createReleasePr(
  vcs: ReturnType<typeof getVcsProvider>,
  head: string,
  base: string,
  title: string,
  body: string,
): Promise<{ number: number; htmlUrl: string } | null> {
  try {
    return await vcs.createPullRequest(head, base, title, body);
  } catch (err) {
    throw new ReleaseError(
      `Pull request could not be created: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
```

Export `createReleasePr` too (needed for the test above) — change its declaration to `export async function createReleasePr(...)`.

Replace the single line (current line 83):

```ts
      releasePr = await vcs.createPullRequest(QA_BRANCH, MAIN_BRANCH, title, bodyLines.join("\n"));
```

with:

```ts
      releasePr = await createReleasePr(vcs, QA_BRANCH, MAIN_BRANCH, title, bodyLines.join("\n"));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/release/release-agent.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/release/release-agent.ts src/release/release-agent.test.ts
git commit -m "feat: wrap release PR creation failures in a typed ReleaseError"
```

---

### Task 7: Orchestrator-level failure categorization and guaranteed cycle close

**Files:**
- Create: `src/orchestrator/failure-category.ts`
- Test: `src/orchestrator/failure-category.test.ts`
- Modify: `src/orchestrator/graph.ts` (imports, and the whole `_runOrchestratorCycle` function, current lines 818-879)

**Interfaces:**
- Consumes: `ConfigError` (Task 2), `JiraAuthError` (Task 3), `GitHubAuthError` (Task 4), `GitNotCleanError`/`GitNotSyncedError`/`assertRepoReadyForCycle` (Task 5), `ReleaseError` (Task 6), `logger`/`runWithCycleLogger` (Task 1), `validateConfig` (Task 2).
- Produces: `categorizeCycleFailure(err: unknown): { category: string; reason: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/orchestrator/failure-category.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("dotenv/config", () => ({}));
vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../db/schema.js", () => ({
  tickets: {}, iterationCycles: {}, fixAttempts: {}, reviewResults: {}, deployments: {}, reportsGenerated: {},
}));
vi.mock("../lib/notify.js", () => ({ notifySlack: vi.fn() }));
vi.mock("../lib/audit-log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../integrations/email.js", () => ({ sendEmail: vi.fn() }));
vi.mock("../integrations/report-template.js", () => ({
  renderPostProcessEmailHtml: vi.fn(),
  renderPostProcessEmailText: vi.fn(),
}));
vi.mock("./final-report.js", () => ({ generateFinalReport: vi.fn() }));
vi.mock("../lib/config.js", () => ({ LABEL_PREFIX: "TEST" }));
vi.mock("../integrations/vcs/factory.js", () => ({ getVcsProvider: () => ({ createPullRequest: vi.fn() }) }));

describe("categorizeCycleFailure", () => {
  it("categorizes a ConfigError as config", async () => {
    const { categorizeCycleFailure } = await import("./failure-category.js");
    const { ConfigError } = await import("../lib/preflight.js");
    const result = categorizeCycleFailure(new ConfigError(["PROJECT_KEY is not set."]));
    expect(result.category).toBe("config");
    expect(result.reason).toContain("PROJECT_KEY");
  });

  it("categorizes a JiraAuthError as jira-auth", async () => {
    const { categorizeCycleFailure } = await import("./failure-category.js");
    const { JiraAuthError } = await import("../integrations/tracker/errors.js");
    const result = categorizeCycleFailure(new JiraAuthError(401, "/rest/api/3/issue/PROJ-1"));
    expect(result.category).toBe("jira-auth");
  });

  it("categorizes a GitHubAuthError as github-auth", async () => {
    const { categorizeCycleFailure } = await import("./failure-category.js");
    const { GitHubAuthError } = await import("../integrations/vcs/errors.js");
    const result = categorizeCycleFailure(new GitHubAuthError(401, "/user"));
    expect(result.category).toBe("github-auth");
  });

  it("categorizes a GitNotCleanError as git-precondition", async () => {
    const { categorizeCycleFailure } = await import("./failure-category.js");
    const { GitNotCleanError } = await import("../lib/repo-config.js");
    const result = categorizeCycleFailure(new GitNotCleanError(["M src/foo.ts"]));
    expect(result.category).toBe("git-precondition");
  });

  it("categorizes a GitNotSyncedError as git-precondition", async () => {
    const { categorizeCycleFailure } = await import("./failure-category.js");
    const { GitNotSyncedError } = await import("../lib/repo-config.js");
    const result = categorizeCycleFailure(new GitNotSyncedError("qa", "behind"));
    expect(result.category).toBe("git-precondition");
  });

  it("categorizes a ReleaseError as release", async () => {
    const { categorizeCycleFailure } = await import("./failure-category.js");
    const { ReleaseError } = await import("../release/release-agent.js");
    const result = categorizeCycleFailure(new ReleaseError("Pull request could not be created: boom"));
    expect(result.category).toBe("release");
  });

  it("falls back to internal for an unrecognized Error", async () => {
    const { categorizeCycleFailure } = await import("./failure-category.js");
    const result = categorizeCycleFailure(new Error("connection reset"));
    expect(result.category).toBe("internal");
    expect(result.reason).toBe("connection reset");
  });

  it("stringifies a non-Error thrown value and still categorizes it internal", async () => {
    const { categorizeCycleFailure } = await import("./failure-category.js");
    const result = categorizeCycleFailure("plain string throw");
    expect(result.category).toBe("internal");
    expect(result.reason).toBe("plain string throw");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/orchestrator/failure-category.test.ts`
Expected: FAIL — `Cannot find module './failure-category.js'`

- [ ] **Step 3: Implement `categorizeCycleFailure`**

```ts
// src/orchestrator/failure-category.ts
import { ConfigError } from "../lib/preflight.js";
import { JiraAuthError } from "../integrations/tracker/errors.js";
import { GitHubAuthError } from "../integrations/vcs/errors.js";
import { GitNotCleanError, GitNotSyncedError } from "../lib/repo-config.js";
import { ReleaseError } from "../release/release-agent.js";

export interface CycleFailure {
  category: string;
  reason: string;
}

export function categorizeCycleFailure(err: unknown): CycleFailure {
  const reason = err instanceof Error ? err.message : String(err);
  if (err instanceof ConfigError) return { category: "config", reason };
  if (err instanceof JiraAuthError) return { category: "jira-auth", reason };
  if (err instanceof GitHubAuthError) return { category: "github-auth", reason };
  if (err instanceof GitNotCleanError || err instanceof GitNotSyncedError) {
    return { category: "git-precondition", reason };
  }
  if (err instanceof ReleaseError) return { category: "release", reason };
  return { category: "internal", reason };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/orchestrator/failure-category.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Wire preflight, the git check, the shared logger, and failure categorization into `_runOrchestratorCycle`**

In `src/orchestrator/graph.ts`, update the imports (top of file):

Replace:
```ts
import { assertTargetRepoConfigured, ensureFreshQaBase } from "../lib/repo-config.js";
```
with:
```ts
import { assertTargetRepoConfigured, ensureFreshQaBase, assertRepoReadyForCycle } from "../lib/repo-config.js";
import { validateConfig } from "../lib/preflight.js";
import { runWithCycleLogger, logger } from "../lib/logger.js";
import { categorizeCycleFailure } from "./failure-category.js";
```

Replace:
```ts
import { eq, and, inArray, notInArray } from "drizzle-orm";
```
with:
```ts
import { eq, and, inArray, notInArray, isNull } from "drizzle-orm";
```

Replace the entire `_runOrchestratorCycle` function (current lines 818-879) with:

```ts
async function _runOrchestratorCycle(existingCycleId?: string, mode: CycleMode = "full") {
  const cycle = existingCycleId
    ? (await db.select().from(iterationCycles).where(eq(iterationCycles.id, existingCycleId)))[0]
    : (
        await db
          .insert(iterationCycles)
          .values({ cycleNumber: 0, openIssueCount: 0, mode })
          .returning()
      )[0];

  if (!cycle) {
    throw new Error(`No iteration_cycles row found for id ${existingCycleId}`);
  }

  const cycleMode = (cycle.mode as CycleMode | undefined) ?? mode;

  await runWithCycleLogger(cycle.id, async () => {
    try {
      validateConfig({
        db: true,
        repo: cycleMode !== "scan",
        jira: cycleMode !== "scan",
        github: cycleMode === "full",
      });

      logger.info("orchestrate", `Starting pipeline — cycle ${cycle.id} (mode: ${cycleMode})`);
      logger.info(
        "orchestrate",
        `Flow: recoverDanglingWork → scan → [mode=scan? finish : triage (verify + decide)] → [mode=triage? preProcessEmail → finish : preProcessEmail → prepareBranch → fix (all tickets) → push → reviewBranch → mergeBranch (direct, no PR) / fixBranch (autofix) → cleanup → scan → triage → [all resolved?] → release (PR to main + email), else continue]`,
      );

      if (cycleMode === "full") {
        await assertRepoReadyForCycle();
      }

      const { initObservability } = await import("../integrations/observability.js");
      await initObservability();

      const checkpointer = PostgresSaver.fromConnString(process.env.DATABASE_URL!);
      await checkpointer.setup();

      const compiled = buildGraph().compile({ checkpointer });

      await runWithPipelineContext({ pipeline_run_id: cycle.id, cycle_number: 0 }, async () =>
        runIssueResolutionPipeline(async () => {
          await compiled.invoke(
            {
              cycleId: cycle.id,
              cycleNumber: 0,
              mode: cycleMode,
              epicKey: null,
              branch: null,
              worktreeDir: null,
              openTicketIds: [],
              fixedTicketIds: [],
              currentTicketIndex: 0,
              reviewVerdict: null,
              reviewComments: null,
              retryCount: 0,
              freshScan: true,
            },
            {
              configurable: { thread_id: cycle.id },
              // Suppresses LangGraph's internal run tracing (_start_, ChannelWrite, node
              // wrapper runs) — the meaningful agent.* / anthropic.* runs attach directly
              // to the root "ForgeAI" run instead (see agent-tracing.ts).
              callbacks: [new SilentLangGraphTracer()],
            },
          );
        }),
      );
    } catch (err) {
      const { category, reason } = categorizeCycleFailure(err);
      logger.error("orchestrate", `Cycle ${cycle.id} failed (${category}): ${reason}`, err);
      logger.error("orchestrate", `CYCLE_FAILED: ${category} | ${reason}`);
      throw err;
    } finally {
      await db
        .update(iterationCycles)
        .set({ endedAt: new Date() })
        .where(and(eq(iterationCycles.id, cycle.id), isNull(iterationCycles.endedAt)));
    }
  });
}
```

This guarantees `endedAt` is set exactly once no matter where in the cycle the failure happens — including a missing/invalid config surfaced through the *existing* `iteration_cycles` row the web app already inserted before spawning the CLI child process, which today would be left "in progress" forever on this exact failure.

- [ ] **Step 6: Run the full test suite to verify nothing else broke**

Run: `npm test`
Expected: PASS — `src/orchestrator/graph.test.ts`'s existing route-function tests are unaffected since they don't touch `_runOrchestratorCycle`.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/failure-category.ts src/orchestrator/failure-category.test.ts src/orchestrator/graph.ts
git commit -m "feat: categorize and guarantee cycle-close on orchestrator failure"
```

---

### Task 8: Top-level CLI catch

**Files:**
- Modify: `src/cli/index.ts`

**Interfaces:**
- Consumes: `logger` from `src/lib/logger.ts` (Task 1).

- [ ] **Step 1: Add the import**

Add near the top of `src/cli/index.ts`, with the other relative imports:

```ts
import { logger } from "../lib/logger.js";
```

- [ ] **Step 2: Replace the final line**

Replace the last line of the file (`program.parseAsync(process.argv);`) with:

```ts
program.parseAsync(process.argv).catch((err) => {
  logger.error("cli", "Command failed", err);
  process.exitCode = 1;
});
```

- [ ] **Step 3: Manually verify**

Run: `npm run <any-command-that-does-not-exist-or-a-command-with-bad-args>` (e.g. `npx tsx src/cli/index.ts fix` without `--ticket`) and confirm the process exits non-zero with a `[cli] Command failed` line instead of an unhandled-rejection stack dump.

- [ ] **Step 4: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat: add top-level catch to the CLI entrypoint"
```

---

### Task 9: Replace `console.*` with the shared logger across `src/`

**Files:**
- Modify: `src/lib/retry.ts`, `src/lib/audit-log.ts`, `src/lib/notify.ts`, `src/lib/git-identity.ts`, `src/integrations/tracker/jira.ts`, `src/integrations/vcs/github.ts`, `src/orchestrator/graph.ts`, `src/release/release-agent.ts`, `src/cli/index.ts`, `src/deploy/conflict-resolver.ts`, `src/deploy/deploy-agent.ts`, `src/development/developer-agent.ts`, `src/development/prompt-builder.ts`, `src/integrations/email.ts`, `src/integrations/observability.ts`, `src/observability/cost-report.ts`, `src/release/final-report.ts`, `src/review/adversarial-review.ts`, `src/review/reviewer-agent.ts`, `src/scan/pa11y-scan.ts`, `src/scan/scan-config.ts`, `src/scan/scanner-agent.ts`, `src/scan/vision-scan.ts`, `src/triage/issue-classifier.ts`, `src/triage/jira-scanner.ts`, `src/triage/triage-agent.ts`, `src/triage/triage-from-reports.ts`

**Transformation rule** (apply to every `console.log`/`console.warn`/`console.error` call in the files above):

1. Add `import { logger } from "<relative path to src/lib/logger.js>";` to the file if not already present (from Task 7/8, `graph.ts` and `cli/index.ts` already have it).
2. If the message argument is (or starts with) a bracketed tag, e.g. `` `[orchestrate] Merge failed...` `` or `"[jira] Ticket not configured"`, extract the tag inside `[...]` as `moduleName` and drop the `"[tag] "` prefix from the message text. If there's no bracketed tag, use the module's own name as a string literal (e.g. `"config"`, `"release"`).
3. `console.log(msg)` → `logger.info(moduleName, msg)`.
4. `console.warn(msg)` → `logger.warn(moduleName, msg)`; `console.warn(msg, errLike)` → `logger.warn(moduleName, msg, errLike)` (pass the second argument through unchanged, whether it's an `Error` or an already-stringified message — `logger.warn`'s third parameter accepts either).
5. `console.error(msg)` → `logger.error(moduleName, msg)`; `console.error(msg, errLike)` → `logger.error(moduleName, msg, errLike)`.
6. **Exception — leave these untouched:** in `src/cli/index.ts`, every `console.log(JSON.stringify(result, null, 2))` (and the similar `console.log(...)` calls inside the `scan:rules` command that print a formatted table) are each command's designed stdout output contract for scripting/piping, not pipeline log lines. Do not touch them.

Four fully worked examples:

```ts
// src/lib/retry.ts — before
      console.error(`[retry] ${label} failed after ${attempt}/${retries} attempt(s).`, msg);
      // ...
      console.warn(`[retry] ${label} attempt ${attempt}/${retries} failed, retrying in ${wait / 1000}s...`, msg);

// after
      logger.error("retry", `${label} failed after ${attempt}/${retries} attempt(s).`, msg);
      // ...
      logger.warn("retry", `${label} attempt ${attempt}/${retries} failed, retrying in ${wait / 1000}s...`, msg);
```

```ts
// src/lib/audit-log.ts — before
    console.warn(
      `[audit-log] Failed to write audit entry for action "${entry.action}":`,
      redactSecrets((err as Error).message ?? String(err)).slice(0, 300),
    );

// after
    logger.warn(
      "audit-log",
      `Failed to write audit entry for action "${entry.action}":`,
      redactSecrets((err as Error).message ?? String(err)).slice(0, 300),
    );
```

```ts
// src/lib/notify.ts — before
    console.log("[notify] SLACK_WEBHOOK_URL not set — report only printed to console.");
    // ...
    console.warn("[notify] Failed to post Slack alert:", (err as Error).message?.slice(0, 200));

// after
    logger.info("notify", "SLACK_WEBHOOK_URL not set — report only printed to console.");
    // ...
    logger.warn("notify", "Failed to post Slack alert:", (err as Error).message?.slice(0, 200));
```

```ts
// src/orchestrator/graph.ts — one representative node (mergeBranchNode), before
    console.log(`[orchestrate] Merging branch ${state.branch} into ${QA_BRANCH}...`);
    // ...
      console.warn(`[orchestrate] Merge ${result.status}${result.blockReason ? `: ${result.blockReason}` : ""}.`);
    // ...
      console.error(`[orchestrate] Merge failed for branch ${state.branch}:`, (err as Error).message?.slice(0, 300));

// after
    logger.info("orchestrate", `Merging branch ${state.branch} into ${QA_BRANCH}...`);
    // ...
      logger.warn("orchestrate", `Merge ${result.status}${result.blockReason ? `: ${result.blockReason}` : ""}.`);
    // ...
      logger.error("orchestrate", `Merge failed for branch ${state.branch}:`, (err as Error).message?.slice(0, 300));
```

Apply the same rule to every remaining `console.*` call in every file in the list above (`graph.ts` has ~30 such calls across its nodes — apply the rule to each one individually, following the four worked examples).

- [ ] **Step 1: Apply the transformation rule to every file in the list**

- [ ] **Step 2: Verify no unintended `console.*` calls remain**

Run:
```bash
grep -rn "console\.\(log\|warn\|error\)" src --include=*.ts | grep -v '\.test\.ts$'
```
Expected: only the `src/cli/index.ts` lines explicitly carved out in rule 6 above (each command's `console.log(JSON.stringify(...))` output line, plus the `scan:rules` table-printing lines) remain.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS — every existing test that spies on `console.warn`/`console.error` (e.g. `jira.test.ts`'s "warns and no-ops when no transition matches the name") needs updating to spy on the equivalent `logger.warn`/`logger.error` call instead; update those spies as part of this step (search test files for `vi.spyOn(console` and change to import + spy on `logger` from the corresponding module's `./logger.js`).

- [ ] **Step 4: Commit**

```bash
git add -A src
git commit -m "refactor: replace console.* with the shared logger across src/"
```

---

### Task 10: Web dashboard — surface the failure category/reason

**Files:**
- Modify: `web/lib/types.ts`
- Modify: `web/lib/run-status.ts`
- Create: `web/lib/run-status.test.ts`

**Interfaces:**
- Produces: `parseFailureFromLog(lines: string[]): { failureCategory: string | null; failureReason: string | null }` (exported).
- `RunStatus` gains: `failureCategory: string | null`, `failureReason: string | null`.

- [ ] **Step 1: Write the failing test**

```ts
// web/lib/run-status.test.ts
import { describe, expect, it } from "vitest";
import { parseFailureFromLog } from "./run-status";

describe("parseFailureFromLog", () => {
  it("extracts category and reason from the CYCLE_FAILED sentinel line", () => {
    const lines = [
      "[orchestrate] Starting pipeline",
      "CYCLE_FAILED: jira-auth | Jira API token is invalid or expired (HTTP 401 on /rest/api/3/issue/PROJ-1). Update JIRA_API_TOKEN and retry.",
    ];
    expect(parseFailureFromLog(lines)).toEqual({
      failureCategory: "jira-auth",
      failureReason: "Jira API token is invalid or expired (HTTP 401 on /rest/api/3/issue/PROJ-1). Update JIRA_API_TOKEN and retry.",
    });
  });

  it("returns nulls when no sentinel line is present", () => {
    expect(parseFailureFromLog(["[orchestrate] Starting pipeline"])).toEqual({
      failureCategory: null,
      failureReason: null,
    });
  });

  it("picks the last sentinel line, ignoring an earlier decoy containing similar text", () => {
    const lines = [
      'CYCLE_FAILED: release | earlier text that a retried step logged: "CYCLE_FAILED: internal | stale decoy"',
      "CYCLE_FAILED: config | PROJECT_KEY is not set.",
    ];
    expect(parseFailureFromLog(lines)).toEqual({
      failureCategory: "config",
      failureReason: "PROJECT_KEY is not set.",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `web/`): `npm test -- lib/run-status.test.ts`
Expected: FAIL — `parseFailureFromLog is not exported`

- [ ] **Step 3: Implement `parseFailureFromLog` and wire it into `deriveRunStatus`**

Add to `web/lib/run-status.ts` (near the other private helper functions, e.g. after `filterLogsByStage`):

```ts
const CYCLE_FAILED_PATTERN = /CYCLE_FAILED:\s*([\w-]+)\s*\|\s*(.+)$/;

/**
 * Scans backwards for the CYCLE_FAILED sentinel line src/orchestrator/graph.ts
 * writes on an unrecoverable failure — the last match wins, since an earlier
 * decoy (e.g. an error message that happens to quote a prior sentinel) should
 * never shadow the real, final one.
 */
export function parseFailureFromLog(lines: string[]): { failureCategory: string | null; failureReason: string | null } {
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(CYCLE_FAILED_PATTERN);
    if (match) {
      return { failureCategory: match[1], failureReason: match[2].trim() };
    }
  }
  return { failureCategory: null, failureReason: null };
}
```

In `web/lib/run-status.ts`'s `deriveRunStatus`, add `...parseFailureFromLog(logLines),` to **both** returned objects (the `endedAt` branch's return, and the "still running" branch's return at the end of the function) — e.g.:

```ts
    return {
      cycleId,
      mode,
      startedAt,
      endedAt,
      stage: completedStage,
      stageDetail: null,
      loopIterationHint: null,
      counts: await deriveCounts(cycle.startedAt, epicKey, database),
      recentLog: logLines.slice(-20),
      processAlive,
      failed: exitCode !== null && exitCode !== 0,
      exitCode,
      result: { /* ...unchanged... */ },
      logsByStage: filterLogsByStage(logLines),
      ...parseFailureFromLog(logLines),
    };
```

(and the same `...parseFailureFromLog(logLines),` addition on the second `return { ... }` later in the function.)

In `web/lib/types.ts`, add two fields to the `RunStatus` interface (after `logsByStage`):

```ts
  logsByStage: Record<Stage, string[]>;
  failureCategory: string | null;
  failureReason: string | null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `web/`): `npm test -- lib/run-status.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add web/lib/types.ts web/lib/run-status.ts web/lib/run-status.test.ts
git commit -m "feat: surface the specific cycle-failure category/reason in run status"
```

---

### Task 11: Web dashboard — new logs screen

**Files:**
- Create: `web/lib/log-files.ts`
- Test: `web/lib/log-files.test.ts`
- Create: `web/app/api/logs/route.ts`
- Create: `web/app/api/logs/[cycleId]/route.ts`
- Create: `web/app/logs/page.tsx`
- Create: `web/app/logs/[cycleId]/page.tsx`
- Modify: `web/app/layout.tsx`

**Interfaces:**
- Produces: `resolveLoggerDir(): string`, `readCycleLog(cycleId: string): Promise<string | null>`.

- [ ] **Step 1: Write the failing test**

```ts
// web/lib/log-files.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const readFileMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
}));

describe("readCycleLog", () => {
  beforeEach(() => {
    readFileMock.mockReset();
  });

  it("returns the file contents when the log exists", async () => {
    readFileMock.mockResolvedValueOnce("line one\nline two\n");
    const { readCycleLog } = await import("./log-files");
    expect(await readCycleLog("cycle-1")).toBe("line one\nline two\n");
  });

  it("returns null when the log file does not exist", async () => {
    readFileMock.mockRejectedValueOnce(new Error("ENOENT"));
    const { readCycleLog } = await import("./log-files");
    expect(await readCycleLog("cycle-1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `web/`): `npm test -- lib/log-files.test.ts`
Expected: FAIL — `Cannot find module './log-files'`

- [ ] **Step 3: Implement `web/lib/log-files.ts`**

```ts
// web/lib/log-files.ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `web/`): `npm test -- lib/log-files.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Add the API routes**

```ts
// web/app/api/logs/route.ts
import { NextResponse } from "next/server";
import { requireDb } from "@/lib/db";
import { iterationCycles } from "@/lib/schema";
import { desc } from "drizzle-orm";

export async function GET() {
  const db = requireDb();
  const cycles = await db
    .select()
    .from(iterationCycles)
    .orderBy(desc(iterationCycles.startedAt))
    .limit(30);

  return NextResponse.json({
    cycles: cycles.map((c) => ({
      cycleId: c.id,
      mode: c.mode,
      startedAt: c.startedAt.toISOString(),
      endedAt: c.endedAt?.toISOString() ?? null,
    })),
  });
}
```

```ts
// web/app/api/logs/[cycleId]/route.ts
import { NextResponse } from "next/server";
import { readCycleLog } from "@/lib/log-files";
import { sanitizeLogLine } from "@/lib/sanitize";
import { CYCLE_ID_PATTERN, API_ERROR } from "@/lib/results-constants";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ cycleId: string }> },
) {
  const { cycleId } = await params;
  if (!CYCLE_ID_PATTERN.test(cycleId)) {
    return NextResponse.json({ error: API_ERROR.invalidCycleId }, { status: 400 });
  }

  const content = await readCycleLog(cycleId);
  if (content === null) {
    return NextResponse.json({ error: "Log not found for this cycle" }, { status: 404 });
  }

  const sanitized = content.split("\n").map(sanitizeLogLine).join("\n");
  return new NextResponse(sanitized, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
```

- [ ] **Step 6: Add the two pages**

```tsx
// web/app/logs/page.tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface LoggedCycle {
  cycleId: string;
  mode: string;
  startedAt: string;
  endedAt: string | null;
}

export default function LogsPage() {
  const [cycles, setCycles] = useState<LoggedCycle[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/logs")
      .then((res) => res.json())
      .then((data) => setCycles(data.cycles))
      .catch(() => setError("Failed to load cycles"));
  }, []);

  if (error) {
    return (
      <main className="container">
        <p>{error}</p>
      </main>
    );
  }
  if (!cycles) {
    return (
      <main className="container">
        <p>Loading…</p>
      </main>
    );
  }

  return (
    <main className="container">
      <h1>Cycle logs</h1>
      <table>
        <thead>
          <tr>
            <th>Cycle</th>
            <th>Mode</th>
            <th>Started</th>
            <th>Ended</th>
          </tr>
        </thead>
        <tbody>
          {cycles.map((c) => (
            <tr key={c.cycleId}>
              <td>
                <Link href={`/logs/${c.cycleId}`}>{c.cycleId}</Link>
              </td>
              <td>{c.mode}</td>
              <td>{new Date(c.startedAt).toLocaleString()}</td>
              <td>{c.endedAt ? new Date(c.endedAt).toLocaleString() : "running"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
```

```tsx
// web/app/logs/[cycleId]/page.tsx
"use client";

import { use, useEffect, useState } from "react";

export default function LogDetailPage({ params }: { params: Promise<{ cycleId: string }> }) {
  const { cycleId } = use(params);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/logs/${cycleId}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? "Failed to load log");
        }
        return res.text();
      })
      .then(setContent)
      .catch((err) => setError(err.message));
  }, [cycleId]);

  return (
    <main className="container">
      <h1>Cycle {cycleId}</h1>
      {error && <p>{error}</p>}
      {content !== null && <pre className="log-view">{content}</pre>}
    </main>
  );
}
```

- [ ] **Step 7: Add the nav link**

In `web/app/layout.tsx`, add a new `Link` inside `<div className="site-nav__links">`, after the existing `Settings` link:

```tsx
              <Link href="/logs" className="site-nav__link">
                Logs
              </Link>
```

- [ ] **Step 8: Manually verify**

Run: `npm run dev` (in `web/`), start a run from the dashboard, then visit `/logs` and confirm the new cycle appears and `/logs/{cycleId}` renders its `logger/{cycleId}/cycle.log` contents.

- [ ] **Step 9: Run the full web test suite**

Run (from `web/`): `npm test`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add web/lib/log-files.ts web/lib/log-files.test.ts web/app/api/logs web/app/logs web/app/layout.tsx
git commit -m "feat: add a dashboard screen to view per-cycle log files"
```

---

### Task 12: Full-suite verification

- [ ] **Step 1: Run the full root test suite**

Run: `npm test`
Expected: PASS, zero failures.

- [ ] **Step 2: Run the full web test suite**

Run (from `web/`): `npm test`
Expected: PASS, zero failures.

- [ ] **Step 3: Type-check both projects**

Run: `npx tsc --noEmit` (root) and (from `web/`) `npx tsc --noEmit` (or `npm run build` if that's the project's type-check gate).
Expected: no errors.

- [ ] **Step 4: Confirm no stray `console.*` calls remain outside the carved-out CLI output lines**

Run: `grep -rn "console\.\(log\|warn\|error\)" src --include=*.ts | grep -v '\.test\.ts$'`
Expected: only the exact lines documented in Task 9, Step 2.
