# ForgeAI — Technical Documentation

ForgeAI is an autonomous **accessibility (WCAG 2.2 A/AA) remediation system**. It scans a target web application, turns the violations into Jira tickets, uses Claude to fix the code, reviews and merges the fixes, re-scans the live site to prove they worked, and finally opens a release pull request for a human to approve.

The system is project-agnostic: every per-project label (branch prefix, PR title, Jira project, LangSmith project) derives from a single `PROJECT_KEY` environment variable (currently `ELMS` — the Employee Leave Management System).

---

## 1. High-level flow

```
Scan → Triage → Fix → Review → Deploy (merge to QA) → Re-scan / Verify → ... loop ... → Release (PR to main)
```

The only human step is reviewing and merging the final **QA → main** pull request that the Release agent opens. Nothing reaches production without it.

---

## 2. Technology stack

### Core runtime
| Layer | Technology |
|---|---|
| Language / runtime | TypeScript (ESM), Node.js 22+ |
| CLI | `commander` (entry: `src/cli/index.ts`, run through `tsx`) |
| Validation | `zod` |
| Config | `dotenv` (`.env`), central constants in `src/lib/config.ts` |
| Testing | `vitest` (unit tests), `@playwright/test` (scan specs) |

### AI / orchestration
| Concern | Technology |
|---|---|
| **Orchestrator framework** | **LangGraph (`@langchain/langgraph`)** — a `StateGraph` state machine in `src/orchestrator/graph.ts` |
| Graph persistence | `@langchain/langgraph-checkpoint-postgres` (`PostgresSaver`), so graph state lives in the same Postgres database |
| Agentic coding (Developer, Conflict Resolver) | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — gives the model Read/Write/Edit/Bash/Grep/Glob inside an isolated git worktree |
| Single-shot LLM calls | Reviewer → Claude Agent SDK with no tools; Triage classifier and Vision scan → Anthropic Messages API (`@anthropic-ai/sdk`). See [section 4.8](#48-ai-sdks-apis-and-models-used) |
| Models (configurable) | Developer / Reviewer / Conflict Resolver / Classifier: `claude-haiku-4-5-20251001` by default; Vision scan: `claude-opus-4-6` |

### Accessibility scanning
| Tool | Role |
|---|---|
| **Playwright** | Drives the browser, handles multi-role login (admin / manager / employee), runs the specs in `src/scan/tests/` |
| **axe-core** (`@axe-core/playwright`) | Primary rule engine, driven by the WCAG 2.2 registry in `src/scan/wcag-rules.ts` |
| **Pa11y** | Secondary rule set (HTML CodeSniffer), de-duplicated by fingerprint against axe results |
| **Claude vision pass** | Screenshot analysis for issues DOM rules cannot see (contrast baked into images, reading order, missing focus indicators) |

### Data
| Concern | Technology |
|---|---|
| Database | PostgreSQL (dedicated DB, separate from the target app's DB) |
| ORM / migrations | Drizzle ORM + `drizzle-kit` (migrations in `drizzle/`) |

### Observability and notifications
| Concern | Technology |
|---|---|
| Tracing / cost tracking | **LangSmith** (`langsmith`) + OpenTelemetry (`@opentelemetry/*`, optional OTLP exporter) |
| Logging | Custom file logger, per-cycle log files under `logger/<cycleId>/cycle.log`, with secret redaction |
| Email | `nodemailer` over SMTP |
| Chat alerts | Slack incoming webhook |

### Web dashboard (`web/`)
Next.js 15 (App Router) · React 19 · Tailwind CSS 4 · Drizzle + `pg` (reads the same Postgres DB) · ESLint with `jsx-a11y`.

---

## 3. Orchestrator (LangGraph)

**Framework:** LangGraph JS. The pipeline is a `StateGraph` whose shared state (`CycleState`) carries `cycleId`, `cycleNumber`, `mode`, `epicKey`, `branch`, `worktreeDir`, `openTicketIds`, `fixedTicketIds`, `currentTicketIndex`, `reviewVerdict`, `reviewComments`, `retryCount` and `freshScan`. Each cycle uses its own `thread_id` and is checkpointed to Postgres.

### Run modes
| Mode | What it does |
|---|---|
| `scan` | Scan and generate the report only |
| `triage` | Scan + create tickets + send pre-process email; no fixing |
| `full` | The complete autonomous pipeline |

### Graph nodes and routing

```
START → recoverDanglingWork ─┬─(recovered branch)→ pushBranch
                             └─(nothing stuck)────→ scan
scan ──(mode=scan)→ finish
     └─────────────→ triage
triage ──(all tickets done/parked/flagged, or MAX_CYCLES)→ release
       └─(unresolved tickets)→ preProcessEmail
preProcessEmail ──(mode≠full)→ finish
                └──────────────→ prepareBranch
prepareBranch ──(no open tickets)→ release (fresh scan) / scan
              └─(tickets)→ fixNext
fixNext ⟲ (one ticket per pass, one commit each)
        ├─(no commits)→ cleanup
        └─(done)→ pushBranch → reviewBranch
reviewBranch ──approved→ mergeBranch → cleanup
             ├─rejected, retries left→ fixBranch → reviewBranch
             └─rejected, retries exhausted→ cleanup (+ alert)
cleanup → scan   (always re-verify against the freshly deployed site)
```

Key design points:
- **One shared branch per batch** — all open tickets are fixed as separate commits on a single `<label>/batch-<tickets>-<ts>` branch, reviewed once, merged once.
- **Direct merge into QA** (no per-ticket PR). A merge alone never marks a ticket done — tickets stay `in_review` until the post-deploy scan proves the violation is gone.
- **Crash recovery** — `recoverDanglingWork` detects tickets stranded in `in_progress`/`in_review` from a crashed run, re-attaches the branch (from the local ref or `origin`), and resumes at review/merge — or skips straight to verification if the branch is already merged into QA.
- **Safety limits** — `MAX_CYCLES = 20`, `MAX_REVIEW_RETRIES` (default 2), git operations serialised by a repo mutex, push/worktree-removal retries with backoff.
- **Settle delay** — after a merge the scan waits `DEPLOY_SETTLE_MS` (default 150 s) for the CI/CD pipeline to deploy.

### Ticket lifecycle
`open → in_progress → in_review → done`, with side exits to `parked` (failed repeatedly) and `flagged` (held out of auto-merge by the scope guard). A previously `done` ticket is reopened if its violation resurfaces.

---

## 4. Agents

Each agent is a plain function with a matching CLI subcommand, so it can run standalone; the orchestrator is a convenience wrapper. Agents that call a model are wrapped with LangSmith `traceable` / `runAgentTrace`.

### 4.1 Scanner Agent
**Files:** `src/scan/` (`scanner-agent.ts`, `axe-scan.ts`, `pa11y-scan.ts`, `vision-scan.ts`, `scan-config.ts`, `wcag-rules.ts`, `tests/*.spec.ts`)
**AI:** Vision pass only (Claude Opus); axe/Pa11y are rule engines.
**What it does:**
- Opens each route in `TARGET_SCAN_ROUTES` in Playwright, authenticating per role from `TARGET_AUTH_ROLES`.
- Runs axe-core against the WCAG 2.2 A/AA criteria registry (55 criteria — see `docs/WCAG_SCAN_RULES.md`); individual criteria/rules can be enabled or disabled via `scan-config.json`, environment variables, or API.
- Optionally runs Pa11y and the Claude vision pass (`SCAN_PA11Y`, `SCAN_VISION`).
- In the orchestrated flow, the scan is the Playwright suite plus `generate-a11y-report.mjs`, producing JSON/HTML reports in `a11y-reports/`.
- Each finding gets a stable **fingerprint** (`sha256(ruleId:selector:pageUrl)`), used for de-duplication and later verification.

### 4.2 Triage Agent
**Files:** `src/triage/` (`triage-from-reports.ts`, `issue-classifier.ts`, `ticket-builder.ts`, `categorize.ts`, `report-reader.ts`, `jira-scanner.ts`)
**AI:** Claude (Haiku by default) classifies each violation type.
**What it does:**
- Reads the scan reports and aggregates violations by rule.
- Classifies each into `code_change`, `bad_data`, `infrastructure` or `design`, and assigns priority P1–P4 plus labels.
- Creates (or reuses) a **Jira epic per cycle**, then one Jira ticket per violation category, mirrored into the local `tickets` / `issues` tables. Existing tickets are de-duplicated; a `done` ticket whose violation resurfaces is reopened.
- **Verification step:** before creating anything, it compares the fresh scan's fingerprints with each `in_review` ticket's original fingerprints. If none still reproduce, the ticket is confirmed fixed (`done`, Jira → Done).
- `jira-scanner.ts` (`sync:jira`) also pulls pre-existing open Jira tickets labelled `accessibility` into the local DB.

### 4.3 Developer Agent
**Files:** `src/development/developer-agent.ts`, `prompt-builder.ts`
**AI:** Claude Agent SDK session (default Haiku 4.5; configurable model, effort, and max turns).
**What it does:**
- Works inside an isolated **git worktree** branched from `origin/<QA branch>`.
- Per ticket, runs a scoped agentic session with tools `Read, Write, Edit, Bash, Grep, Glob` (permission mode `acceptEdits`) to apply the accessibility fix, then commits it.
- Records a `fix_attempts` row per ticket and moves the Jira ticket to **In Progress**.
- A separate `fixBuildErrors` path (the "autofix" step) addresses build/lint/test failures or blocking review findings on the same branch.
- The system prompt is static and byte-identical across calls so it can be prompt-cached.

### 4.4 Reviewer Agent
**Files:** `src/review/` (`reviewer-agent.ts`, `scope-guard.ts`, `test-gate.ts`, `adversarial-review.ts`, `ephemeral-preview.ts`)
**AI:** Claude Agent SDK with no tools (read-only analysis of the diff).
**What it does** — reviews the whole branch diff in four layers:
1. **Scope guard** — flags the change for manual review if it touches sensitive paths (`auth`, `payment`, `security`, `.env`, `jwt`) or exceeds 200 changed lines.
2. **Test gate** — per touched workspace (`backend`/`frontend`): install, build, lint, test. Failures in changed files block; pre-existing failures elsewhere are non-blocking; missing scripts are skipped.
3. **Targeted re-scan** — builds an ephemeral preview and re-runs axe on the affected pages (non-blocking if the preview can't start).
4. **Adversarial review** — a fresh Claude call that did not write the code returns structured findings (`blocking` / `suggestion`; categories: security, correctness, regression, acceptance-criteria, test-coverage, style).

Verdict is `approved` only if the test gate passes, the re-scan passes (or was skipped), and there are zero blocking findings. Results are stored in `review_results` and summarised as Jira comments. Ticket outcomes: clean approval → `in_review`; approved but scope-flagged → `flagged`; rejected twice → `parked`; otherwise back to `open`.

### 4.5 Deploy Agent
**Files:** `src/deploy/deploy-agent.ts`, `conflict-resolver.ts`
**AI:** The Conflict Resolver is a Claude Agent SDK session (tools `Read, Edit, Grep, Glob`); the Deploy Agent itself is deterministic.
**What it does:**
- Pre-merge checks that the latest review is approved with no blocking findings.
- Merges the fix branch **directly into the QA branch** through the GitHub API (`/merges`).
- On a conflict: updates the branch from QA, and if needed invokes the **Conflict Resolver**, which resolves conflict markers while preserving both the accessibility fix and legitimate upstream changes, then retries the merge.
- Creates a **rollback tag** (`<label>-<qa>-<sha7>`), records a `deployments` row, and comments on the Jira tickets (branch, merge commit, tag, review notes).
- Tickets remain `in_review` — only the verification scan marks them done.
- Terminal failures trigger a Slack + email alert.

### 4.6 Release Agent
**Files:** `src/release/release-agent.ts`, `final-report.ts`, `src/integrations/report-template.ts`
**AI:** None (deterministic).
**What it does:**
- Runs once all tickets are `done`, `parked` or `flagged` (or the cycle cap is hit).
- Opens (idempotently) a **pull request from the QA branch to the production branch** — the one human gate.
- Compiles fixed / parked (with attempt history and remaining blockers) / flagged tickets into a final report, emails it (HTML + text), and posts a Slack summary.
- Report and email generation are guarded by the unique `(cycleId, type)` row in `reports_generated`, so a resumed cycle never re-sends.

### 4.7 Supporting orchestrator steps (non-model)
- **recoverDanglingWork** — crash recovery described above.
- **preProcessEmail** — one email per cycle summarising issue counts by severity and the tickets about to be worked, with the HTML scan report attached.
- **prepareBranch / pushBranch / cleanup** — worktree creation, push with retry, worktree and ticket-state cleanup.

### 4.8 AI SDKs, APIs and models used

All AI is provided by **Anthropic Claude**. Two client libraries are used:

| Library | Package | How it is used |
|---|---|---|
| **Claude Agent SDK** | `@anthropic-ai/claude-agent-sdk` (`query()`) | Multi-turn agentic sessions, optionally with file/shell tools |
| **Anthropic Messages API** | `@anthropic-ai/sdk` (`client.messages.create`) | Direct single-shot calls (text classification, image analysis) |

| Agent / step | SDK / API | Default model | Override env var | Tools | Notes |
|---|---|---|---|---|---|
| Developer (fix + autofix) | Claude Agent SDK | `claude-haiku-4-5-20251001` | `CLAUDE_DEVELOPER_MODEL` | Read, Write, Edit, Bash, Grep, Glob | Effort `medium` (`CLAUDE_DEVELOPER_EFFORT`), thinking disabled, max 40 turns (`CLAUDE_DEVELOPER_MAX_TURNS`) |
| Conflict Resolver | Claude Agent SDK | `claude-haiku-4-5-20251001` | `CLAUDE_DEVELOPER_MODEL` (shared) | Read, Edit, Grep, Glob | Same effort / turn cap as Developer |
| Reviewer (adversarial review) | Claude Agent SDK | `claude-haiku-4-5-20251001` | `CLAUDE_REVIEWER_MODEL` | None (read-only) | Effort `medium` (`CLAUDE_REVIEWER_EFFORT`); returns structured JSON findings |
| Triage issue classifier | Anthropic Messages API | `claude-haiku-4-5-20251001` | `CLASSIFIER_MODEL` | n/a | Returns issue type, priority and labels as JSON |
| Vision scan | Anthropic Messages API | `claude-opus-4-6` | `CLAUDE_VISION_MODEL` | n/a | Screenshot input; structured-output schema for findings |
| Scanner (axe / Pa11y), Deploy, Release | No model | n/a | n/a | n/a | Deterministic |

Notes:
- **Authentication:** a single `ANTHROPIC_API_KEY`.
- **Cost design:** Haiku 4.5 is the default for the high-volume agentic steps; Opus is reserved for the vision pass. Models and effort can be raised per agent through the env vars above if a target project needs stronger reasoning.
- **Prompt caching:** Developer, Reviewer and Conflict Resolver system prompts are static and byte-identical across calls so they can be cached.
- **Tracing:** every model call goes through `traceAnthropicAgentSdkQuery` or `traceAnthropicMessagesCreate`, which record tokens, cache usage and cost in LangSmith (see section 5.3).
- The orchestrator (LangGraph) makes no model calls itself — it only sequences the agents.

---

## 5. Integrations

### 5.1 Jira (issue tracker)
- **Pattern:** adapter behind a `TrackerProvider` interface (`src/integrations/tracker/`), selected via `TRACKER_PROVIDER` (default `jira`). Nothing outside the adapter depends on Jira-specific APIs or JQL.
- **API:** Jira Cloud REST v3 — `/rest/api/3/issue`, `/issue/{key}/transitions`, `/issue/{key}/comment`, `/search/jql`. Authenticated with `JIRA_EMAIL` + `JIRA_API_TOKEN`.
- **Capabilities:** `ensureEpic`, `createTicket`, `updateTicket`, `findExisting` (dedup), `transitionTicket`, `comment`, `search`.
- **Rich text:** Markdown ⇄ Atlassian Document Format converters (`markdown-to-adf.ts`, `adf-to-markdown.ts`, round-trip tested).
- **Status flow used:** To Do → In Progress → In Review → Done.
- **Config:** `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, optional `JIRA_PROJECT_KEY` (defaults to `PROJECT_KEY`). If unset, tickets are still created in Postgres only.

### 5.2 GitHub (version control)
- **Pattern:** adapter behind a `VcsProvider` interface (`src/integrations/vcs/`), selected via `VCS_PROVIDER` (default `github`).
- **API:** GitHub REST (`api.github.com`) with `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`.
- **Used for:** branch merges (`/merges`), updating a stale branch from base, rollback tags (`/git/refs`), creating/finding the release pull request, PR reviews and comments, authenticated remote URL for `git push`.
- **Branch model:** fix branches → `GITHUB_QA_BRANCH` (auto-merge after review) → `GITHUB_BASE_BRANCH` (human-approved release PR).
- **Git identity:** `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` for commits on CI/server machines.

### 5.3 LangSmith (observability and cost)
- **Enabled by:** `LANGSMITH_TRACING_V2=true` + `LANGSMITH_API_KEY` (legacy `LANGCHAIN_*` names accepted). `LANGSMITH_PROJECT` defaults to `<project-key>-a11y-agents`. A startup check fails loudly if tracing is requested but the key is missing.
- **Trace structure:** one root run (`ForgeAI`) per cycle, with `agent.triage`, `agent.developer`, `agent.reviewer`, `agent.deploy`, `agent.release` child runs attached directly to the root. A `SilentLangGraphTracer` suppresses LangGraph's internal plumbing runs so only meaningful runs remain.
- **Model-call tracing:** custom wrappers (`anthropic-tracing.ts`) trace both Anthropic Messages calls and Claude Agent SDK sessions, capturing tokens, cache usage and cost.
- **Totals:** `pipeline-context.ts` (AsyncLocalStorage) accumulates per-agent token usage and models used onto the root run.
- **Safety:** `sanitize.ts` redacts secrets and truncates large payloads before anything is sent.
- **Cost report:** `npm run cost-report` pulls LLM runs from LangSmith and breaks token usage down by agent and model.

### 5.4 Other integrations
| Integration | Purpose |
|---|---|
| OpenTelemetry | Spans for scan steps etc.; console by default, OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set |
| Slack | Cycle summaries and unrecoverable-error alerts (`SLACK_WEBHOOK_URL`) |
| SMTP email | Pre-process and post-process (final report) emails (`SMTP_*`, `EMAIL_FROM`, `EMAIL_TO`) |
| Anthropic API | All model calls (`ANTHROPIC_API_KEY`) |

All optional integrations degrade gracefully — a console warning, not a crash — when unconfigured.

---

## 6. Data model (PostgreSQL / Drizzle)

| Table | Purpose |
|---|---|
| `scan_runs` | One row per scan/report import |
| `issues` | Individual violations, unique by `fingerprint`; severity critical/serious/moderate/minor |
| `tickets` | Remediation tickets (Jira key, epic, category, linked issue ids, status) |
| `fix_attempts` | Each Developer commit per ticket (branch, commit SHA, attempt number) |
| `review_results` | Verdict, scope-guard flag, structured findings, blocking-finding count |
| `deployments` | QA merges: commit SHA, rollback tag, status |
| `iteration_cycles` | One row per pipeline run (mode, epic, start/end time) |
| `audit_log` | Append-only trail of workflow actions, secrets redacted |
| `reports_generated` | Idempotency guard for emails and final reports |

LangGraph checkpoint tables are created in the same database by `PostgresSaver.setup()`.

---

## 7. Cross-cutting infrastructure (`src/lib/`)

| Module | Purpose |
|---|---|
| `preflight.ts` | Collects *all* config problems in one pass before a cycle starts |
| `repo-config.ts` | Validates the target repo path / readiness, ensures a fresh QA base |
| `logger.ts` | Per-cycle log files (`logger/<cycleId>/cycle.log`), never throws on I/O failure, redacts secrets |
| `audit-log.ts` | Best-effort DB audit writes |
| `retry.ts` | Shared retry-with-backoff helper |
| `mutex.ts` | Serialises git operations on the target repo |
| `notify.ts` | Slack + email alerts for unrecoverable errors |
| `git-identity.ts`, `exec.ts` | Git identity setup, child-process wrapper |
| `orchestrator/failure-category.ts` | Classifies cycle failures for the dashboard |

---

## 8. Web dashboard (`web/`)

A Next.js app that starts and monitors runs:
- **Home** — choose a mode (scan / triage / full), start a run, see the stage timeline, live activity feed, progress and results.
- **API routes** — `/api/workflow/start`, `/active`, `/[cycleId]/status|results|report`, `/api/logs`, `/api/settings/email`.
- **Process model** — the start route inserts the `iteration_cycles` row, then spawns the orchestrator as a detached child process (`tsx src/cli/index.ts orchestrate --cycle-id ... --mode ...`) with output to a per-run log file. A stalled-run check detects when the process died but the DB row remains open.
- **Logs** — `/logs` and `/logs/[cycleId]` browse the per-cycle log files with pagination.
- **Settings** — notification email configuration.

---

## 9. CLI reference

| Command (`npm run …`) | Action |
|---|---|
| `pipeline` / `dev -- orchestrate` | Full LangGraph cycle (`--mode scan|triage|full`, `--cycle-id`) |
| `scan` / `scan:playwright` | Playwright + axe scan and report generation |
| `triage:reports` (`:dry`) | Turn report JSON into Jira tickets + DB rows |
| `sync:jira` | Import open Jira accessibility tickets |
| `fix:all` | Developer agent over all open tickets on one branch |
| `fix`, `review`, `deploy`, `release` | Run a single agent standalone |
| `review:deploy` | Re-review existing attempts and deploy approved ones |
| `cost-report` | LangSmith token/cost breakdown |
| `db:generate`, `db:migrate`, `db:studio` | Drizzle migrations / studio |
| `test` | Vitest unit tests |

---

## 10. Configuration summary

| Group | Variables |
|---|---|
| Identity | `PROJECT_KEY`, `TICKET_LABEL_PREFIX` |
| Database | `DATABASE_URL` |
| Target app | `TARGET_REPO_PATH`, `TARGET_FRONTEND_URL`, `TARGET_SCAN_ROUTES`, `TARGET_LOGIN_URL`, `TARGET_AUTH_ROLES`, `DEPLOY_SETTLE_MS` |
| Claude | `ANTHROPIC_API_KEY`, `CLAUDE_DEVELOPER_MODEL/_EFFORT`, `CLAUDE_REVIEWER_MODEL/_EFFORT`, `CLAUDE_VISION_MODEL`, `CLAUDE_DEVELOPER_MAX_TURNS`, `CLASSIFIER_MODEL` |
| Scan sources | `SCAN_PA11Y`, `SCAN_VISION`, `AXE_*` rule/criteria toggles |
| Jira | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`, `TRACKER_PROVIDER` |
| GitHub | `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BASE_BRANCH`, `GITHUB_QA_BRANCH`, `GIT_AUTHOR_NAME/EMAIL`, `VCS_PROVIDER` |
| LangSmith / OTel | `LANGSMITH_TRACING_V2`, `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT`, `OTEL_EXPORTER_OTLP_ENDPOINT` |
| Notifications | `SLACK_WEBHOOK_URL`, `SMTP_HOST/PORT/USER/PASS`, `EMAIL_FROM`, `EMAIL_TO` |
| Tuning | `MAX_REVIEW_RETRIES`, `DEVELOPER_MAX_RETRIES`, `CONFLICT_RESOLVER_MAX_RETRIES` |

See `.env.example` for the authoritative list.

---

## 11. Repository layout

```
src/
  cli/            CLI entry point and subcommands
  orchestrator/   LangGraph graph, failure categorisation
  scan/           Scanner agent, axe/Pa11y/vision scanners, WCAG rule registry, Playwright specs
  triage/         Triage agent, issue classifier, ticket builder, Jira sync
  development/    Developer agent and prompt builder
  review/         Reviewer agent, scope guard, test gate, adversarial review, ephemeral preview
  deploy/         Deploy agent and conflict resolver
  release/        Release agent and final report
  integrations/   tracker/ (Jira), vcs/ (GitHub), email, report templates, OpenTelemetry
  observability/  LangSmith tracing, pipeline context, sanitisation, cost report
  db/             Drizzle schema and client
  lib/            Config, logging, retry, mutex, preflight, notify, audit log
web/              Next.js dashboard
drizzle/          SQL migrations
docs/             This document, WCAG rules, design specs, plans, prompts
```

---

## 12. Known caveats

- **Pa11y** can crash on some SPAs (an HTML CodeSniffer `.replace()` error); the failure is contained per route and that source contributes zero findings.
- **Test gate** only protects the target repo if that repo has real `build`/`lint`/`test` scripts; missing scripts are skipped.
- **Isolation** relies on per-batch git worktrees, not container/process sandboxing.
- The root `README.md` still describes an older per-ticket flow (per-ticket PRs, SendGrid, retry-once-then-park); this document reflects the current code (single batch branch, direct merge into QA, SMTP via nodemailer).
