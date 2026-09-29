# Exception handling & per-cycle logging — design spec

Date: 2026-09-29
Status: approved (design), pending spec review

## Problem

Error handling across the pipeline is ad hoc: config validation is split
between import-time throws, use-time throws, and silent skip-with-warn;
Jira/GitHub HTTP failures collapse into one generic `Error` string; most
orchestrator nodes catch-and-continue but a few (release agent's PR
creation, the CLI's top-level dispatch, `_runOrchestratorCycle`'s graph
invocation) have no catch at all and crash the process; there is no
structured or persisted logging beyond `console.*`, which the web
dashboard scrapes with regex to reconstruct run status. A crashed cycle
leaves its `iteration_cycles` row with `endedAt` null forever (until the
next run's orphan-detection closes it).

This spec covers six required failure scenarios end-to-end:

1. Required configuration missing
2. Internal/unexpected server error
3. Jira API token invalid or expired
4. Git branch not clean / not pulled / not pushed
5. PR not created due to a technical failure
6. Any individual agent (triage/developer/reviewer/deploy/release) fails,
   with a clear, agent-specific message

Plus: a per-cycle logger folder with detailed logs, and a new dashboard
screen to view them.

## Non-goals

- No changes to Slack/email alerting (`src/lib/notify.ts` keeps its
  existing 3 call sites, untouched).
- No database schema changes. `iteration_cycles.endedAt` already exists
  and is reused; failure reason is derived from the log file, not stored
  in a new column — per this project's standing rule against schema
  changes without explicit structural-override instruction.
- No retry-policy changes beyond what `src/lib/retry.ts` already does.
- No change to the *mechanism* the web app uses to spawn the CLI
  (`web/lib/process-runner.ts` keeps piping child stdout/stderr to
  `web/.run/{cycleId}.log`) — that file remains as-is; the new
  `logger/{cycleId}/cycle.log` is additional, not a replacement for it.

## A. Logger module (`src/lib/logger.ts`, new)

A single shared logger, exposing `logger.info(module, message, meta?)`,
`logger.warn(...)`, `logger.error(module, message, error?, meta?)`.

- Backed by Node's `AsyncLocalStorage`, following the same pattern
  `src/observability/pipeline-context.ts` already uses to carry
  `cycleId`/`cycle_number` through tracing without threading it through
  every function signature. The logger reads the current cycle context
  from ALS; no call site needs to pass `cycleId` explicitly.
- Cycle-scoped calls (ALS context present) write to
  `logger/{cycleId}/cycle.log`, plain text, one line per entry:
  `[ISO timestamp] [LEVEL] [module] message` followed by an indented
  stack trace block for `error()` calls with an `Error` object.
- Calls made before a cycle exists (CLI startup, config preflight,
  `cli/index.ts` parsing) write to `logger/startup-{ISO timestamp}.log`.
- Every call also echoes to `console.log`/`console.warn`/`console.error`
  with the same `[module]` prefix convention already used today, so
  `web/lib/process-runner.ts`'s existing stdout-piping and
  `web/lib/run-status.ts`'s regex-based stage detection keep working
  unchanged.
- `logger/` is created at repo root (sibling to `src/`), added to
  `.gitignore` (mirrors how `.run/`/`reports/` are already runtime
  output, not committed).
- All existing `console.log/console.warn/console.error` call sites under
  `src/` (roughly 100+, per the codebase survey — `graph.ts`, `jira.ts`,
  `github.ts`, `retry.ts`, `notify.ts`, `audit-log.ts`,
  `process-runner.ts` stays as-is since it's in `web/`, the triage/
  development/review/deploy/release agent files, `exec.ts`,
  `repo-config.ts`, `git-identity.ts`, `cli/index.ts`) are swapped to
  call `logger.*` instead. `web/` keeps its own separate `console.*`
  usage (it's a different process/runtime; not in scope).

## B. Config preflight validation (`src/lib/preflight.ts`, new)

- `validateConfig(mode: "scan" | "triage" | "full")` runs at the very
  start of `cli/index.ts`, before any command dispatch and before
  `src/lib/config.ts`'s existing import-time `PROJECT_KEY` check would
  otherwise crash the process.
- Checks every variable required for the given mode: `PROJECT_KEY`,
  `DATABASE_URL`, `TARGET_REPO_PATH` (existence + is a git repo, reusing
  `assertTargetRepoConfigured` from `repo-config.ts`), and — only for
  modes that need them — Jira vars (`JIRA_BASE_URL`, `JIRA_EMAIL`,
  `JIRA_API_TOKEN`) and GitHub vars (`GITHUB_TOKEN`, `GITHUB_OWNER`,
  `GITHUB_REPO`).
- Collects **all** problems in one pass (not fail-on-first), so the user
  sees the complete list of what's missing in one message instead of
  fixing one variable at a time.
- On failure: logs the full list via `logger.error("preflight", ...)`
  (goes to the startup log, since no cycle exists yet), prints the same
  list to stderr, exits with code 1. No `iteration_cycles` row is
  created for this case — nothing has started yet.
- `src/lib/config.ts`'s existing `PROJECT_KEY` throw-at-import stays as
  a defense-in-depth backstop but is no longer the primary path, since
  `validateConfig()` runs first and gives a much clearer combined
  message.

## C. Typed Jira/GitHub errors

- New file `src/integrations/tracker/errors.ts`: `JiraAuthError`
  (extends `Error`, thrown when `jiraFetch` in `jira.ts` sees a 401/403
  response — message: `"Jira API token is invalid or expired. Update
  JIRA_API_TOKEN and retry."`) and `JiraApiError` (any other non-OK
  response — message includes status + truncated body, same as today
  but via a typed class so callers can distinguish auth failures from
  everything else).
- New file `src/integrations/vcs/errors.ts`: `GitHubAuthError` (401/403
  from `ghFetch` in `github.ts` — message: `"GitHub token is invalid or
  expired. Update GITHUB_TOKEN and retry."`) and `GitHubApiError` (other
  non-OK responses).
- `jiraFetch`/`ghFetch` throw the typed error instead of a bare `Error`.
  Existing call sites that catch-and-warn (best-effort ops) are
  unchanged in *behavior* — they still swallow and continue — but the
  logged message is now the specific typed-error message instead of a
  raw HTTP body dump.
- Call sites that currently let the error propagate (Jira `search()` at
  `jira.ts:198`, and anywhere GitHub errors reach the orchestrator
  uncaught) now propagate a typed error, which the orchestrator's
  top-level catch (§F) can recognize and turn into the specific
  dashboard message "Jira API token expired" / "GitHub token expired"
  rather than a generic failure.

## D. Git precondition checks

- Extend `src/lib/repo-config.ts` with
  `assertRepoReadyForCycle(repoPath: string)`:
  - `git status --porcelain` must be empty (clean tree) — throws
    `GitNotCleanError` listing the dirty files if not.
  - Fetches `origin` and compares the base branch
    (`MAIN_BRANCH`/`QA_BRANCH`) local vs. `origin/<branch>` — if the
    local ref is behind, throws `GitNotSyncedError` ("branch is behind
    origin — pull before running"); if ahead with unpushed commits,
    throws the same error type with a "push before running" message.
  - Reuses the existing `run()` wrapper (`src/lib/exec.ts`) for all git
    invocations — no new git-invocation mechanism.
- Called once at the start of `_runOrchestratorCycle` (before
  `recoverDanglingWorkNode`), so a dirty/unsynced repo is caught before
  any worktree/branch work begins, rather than surfacing confusingly
  mid-cycle.

## E. PR creation error handling

- `runReleaseAgent` in `src/release/release-agent.ts` wraps the
  `vcs.createPullRequest(...)` call (currently fully uncaught) in a
  try/catch. On failure, logs the full error via
  `logger.error("release", ...)` and throws a `ReleaseError` with a
  user-facing message: `"Pull request could not be created: <reason>"`
  (reason = the typed GitHub error's message when available, else the
  raw error message).
- `releaseNode` in `graph.ts` (also currently uncaught) catches
  `ReleaseError` specifically (in addition to generic errors) so the
  message reaching the top-level handler is the specific one, not a
  generic "release failed".

## F. Orchestrator-level failure policy

- `_runOrchestratorCycle` (`graph.ts`) gets a `try { ... } finally { ... }`
  around `compiled.invoke(...)`:
  - `catch`: logs the full error (message + stack) via
    `logger.error("orchestrator", ...)`, then writes one fixed-format
    sentinel line to the cycle log:
    `CYCLE_FAILED: <category> | <user-facing reason>` where `<category>`
    is one of `config`, `internal`, `jira-auth`, `github-auth`,
    `git-precondition`, `release`, `agent:<stage-name>` — derived from
    the error type (typed errors from §C/§D/§E map directly; anything
    else falls back to `internal`).
  - `finally`: sets `iteration_cycles.endedAt = now()` for this cycle if
    it isn't already set — guaranteeing cycles never stay perpetually
    "in progress" after a crash, closing the gap that today only
    `web/app/api/workflow/start/route.ts`'s orphan-detection covers (and
    only on the *next* run).
  - Re-throws after logging, so `cli/index.ts`'s top-level catch (below)
    still sees the failure and exits non-zero.
- `cli/index.ts`: `program.parseAsync(process.argv)` gets a `.catch()`
  (there is none today) that logs via `logger.error("cli", ...)` and
  calls `process.exit(1)`.
- Individual agent failures (scenario 6): the existing per-node
  try/catch in `graph.ts` (`fixNextNode`, `fixBranchNode`, etc.) keep
  their current "log, reset ticket state, continue the batch" behavior
  for recoverable per-ticket failures — that policy is intentionally
  unchanged, since one ticket's fix failing shouldn't abort every other
  ticket in the batch. What's added: each of those catches now uses
  `logger.error(<agent-name>, ...)` (so the specific agent's failure is
  clearly attributed in the log) instead of `console.error`, and if the
  *whole* stage is unrecoverable (e.g. the LLM call itself throws
  outside the retryable path, or a required precondition for that stage
  fails), it propagates up to the top-level catch above rather than
  being silently swallowed — this is the one behavior change: today a
  few spots do `catch {}`/`catch { /* best-effort */ }` with no log at
  all (e.g. `graph.ts:552`); those become `logger.warn` at minimum so
  nothing fails completely silently.

## G. Web dashboard surfacing

- `web/lib/run-status.ts`'s existing regex-based derivation gains one
  more pattern: match the `CYCLE_FAILED: <category> | <reason>` sentinel
  line (read from `logger/{cycleId}/cycle.log`, resolved via the same
  "root pipeline dir" path convention `web/lib/process-runner.ts`
  already uses) and expose `{ failed: true, category, reason }` instead
  of just an inferred "failed" status.
- `web/app/api/workflow/[cycleId]/status/route.ts` includes this in its
  response; the existing run-progress UI shows the specific `reason` in
  its error state instead of a generic "failed" label.
- New logs screen:
  - `web/app/logs/page.tsx` — lists recent cycles (id, mode, started/ended
    time, pass/fail) with a link to each one's log.
  - `web/app/logs/[cycleId]/page.tsx` — renders the raw content of
    `logger/{cycleId}/cycle.log` (read-only, plain text, newest-first or
    scrollable).
  - `web/app/api/logs/[cycleId]/route.ts` — new read-only API route that
    resolves and streams that file's contents (mirrors the existing
    `report` route's file-serving pattern).

## H. Testing

- `logger.test.ts`: writes go to the right file under ALS context;
  writes before any context exists go to the startup log; console
  echoing still happens.
- `preflight.test.ts`: each required var missing (individually and in
  combination) produces the expected combined error list; a fully
  configured env passes.
- `tracker/errors.test.ts` / `vcs/errors.test.ts`: 401/403 responses
  produce the auth-specific typed error and message; other non-OK
  statuses produce the generic typed error.
- `repo-config.test.ts`: dirty tree, behind-origin, and ahead-with-
  unpushed-commits each throw the expected typed error; clean+synced
  passes.
- `release-agent.test.ts`: a thrown/rejected `createPullRequest` is
  caught and re-surfaced as `ReleaseError` with the expected message.
- `graph.test.ts` (or equivalent orchestrator test): forcing an error in
  each of the 6 scenario categories results in `endedAt` being set and
  the correct `CYCLE_FAILED` sentinel category being written.

## Files touched (summary)

New: `src/lib/logger.ts`, `src/lib/preflight.ts`,
`src/integrations/tracker/errors.ts`, `src/integrations/vcs/errors.ts`,
`web/app/logs/page.tsx`, `web/app/logs/[cycleId]/page.tsx`,
`web/app/api/logs/[cycleId]/route.ts`.

Modified: `src/lib/config.ts`, `src/lib/repo-config.ts`,
`src/integrations/tracker/jira.ts`, `src/integrations/vcs/github.ts`,
`src/orchestrator/graph.ts`, `src/release/release-agent.ts`,
`src/cli/index.ts`, every other `src/` file currently using
`console.log/warn/error` (logger swap), `web/lib/run-status.ts`,
`web/app/api/workflow/[cycleId]/status/route.ts`, `.gitignore`.

Not modified: `src/lib/notify.ts`, `web/lib/process-runner.ts`,
`src/db/schema.ts` (no migration), `drizzle/`.
