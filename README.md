# Accessibility Remediation Agent System

Autonomous scan → triage → fix → review → deploy → loop → release, currently
pointed at [`employee-leave-management-system`](https://github.com/IXBalaji/employee-leave-management-system)
via `PROJECT_KEY="ELMS"`. The codebase is reusable across target projects —
every per-project label (branch prefix, PR titles, Jira project) derives from
`PROJECT_KEY`, never hardcoded.

Architecture rationale (LangGraph orchestrator + Postgres checkpointer instead
of a separate job queue, Claude Agent SDK per agent, single human checkpoint at
the end-of-cycle PR) lives in the earlier design-session doc.

## Stack

Node.js 22+, TypeScript, LangGraph (+ its Postgres checkpointer), Claude Agent SDK,
Drizzle ORM, Playwright + axe-core + Pa11y + a Claude vision pass,
Jira REST v3, GitHub REST API, SendGrid, OpenTelemetry. See `.env.example` for
every credential each piece needs — everything beyond `DATABASE_URL` and the
target-app vars is optional and degrades gracefully (a clear console warning,
not a crash) when unconfigured.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

| Var | Required for |
|---|---|
| `PROJECT_KEY` | everything — the source of truth for branch/PR/Jira labeling |
| `DATABASE_URL` | everything — the system of record |
| `TARGET_REPO_PATH` | Developer/Reviewer agents (git worktrees, diffs) |
| `TARGET_FRONTEND_URL`, `TARGET_SCAN_ROUTES` | Scanner agent |
| `ANTHROPIC_API_KEY` | Developer agent's fix, Reviewer agent's adversarial review, the vision scan source |
| `CLAUDE_DEVELOPER_MODEL`/`_EFFORT`, `CLAUDE_REVIEWER_MODEL`/`_EFFORT` | optional — model/effort tiering, defaults to Sonnet |
| `SCAN_PA11Y`/`SCAN_VISION` | optional — set to `"false"` to disable a scan source |
| `JIRA_*` | Triage agent's ticket creation — without it, tickets are still created in Postgres, just not in Jira |
| `GITHUB_*` | Developer agent's PR, Deploy agent's merge + rollback tag, Release agent's final PR |
| `SLACK_WEBHOOK_URL`, `SENDGRID_API_KEY`/`EMAIL_*` | Release agent's notification — without either, the report just prints to console |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | optional — leave unset to trace to the console only |
| `LANGSMITH_TRACING_V2`, `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT` | optional — LangSmith tracing of every agent end to end (scan/triage/developer/reviewer/deploy/release are all `traceable()`-wrapped, plus the two Claude Agent SDK model calls) |

This deployment uses a **local PostgreSQL server** (not Docker) — a dedicated
database, separate from the target app's own database:

```bash
# one-time, if the DB doesn't exist yet: createdb elms_a11y (or via psql/pgAdmin)
npm run db:generate   # generate SQL from src/db/schema.ts
npm run db:migrate    # apply it
```

Start the target app in a separate terminal so the Scanner has something to hit
(or point `TARGET_FRONTEND_URL` at an already-hosted environment):

```bash
cd "../EmployeeLeaveManagement/backend" && npm run dev   # http://localhost:4000
cd "../EmployeeLeaveManagement/frontend" && npm run dev  # http://localhost:5173
```

## Running an agent standalone

Every agent is a plain function with a matching CLI subcommand — this is what
"any agent runs independently" means (see architecture doc §01/§02): the
orchestrator graph is a convenience wrapper, not a dependency.

```bash
npm run scan                              # Playwright + axe-core against src/scan/tests, writes a11y-reports/*.json
npm run triage:reports                    # Triage the JSON reports above into Jira tickets + local DB
npm run sync:jira                         # Pull any open Jira tickets not yet tracked locally into the DB
npm run fix:all                           # Developer agent against every open ticket in the local DB
npm run review -- --attempt <fixAttemptId>
npm run deploy -- --attempt <fixAttemptId>
npm run release -- --cycle <cycleId>
```

Two older, DB-only equivalents of scan/triage are also still wired up as standalone
CLI subcommands (`npm run scan:agent`, `npm run triage -- --scan-run <scanRunId>`) —
they predate the report-based flow above and aren't part of `orchestrate`, but
remain independently invocable per the "any agent runs independently" design.

## Running the full autonomous cycle

```bash
npm run orchestrate   # alias: npm run pipeline
```

Drives the LangGraph state machine end to end: scan (Playwright) → triage the
JSON reports into tickets → sync any pre-existing open Jira tickets → fan out
to every open ticket (Developer → Reviewer, retry once on rejection, park on a
second rejection, hold out of merge on a scope-guard flag) → Deploy on approval
→ loop back to scan → Release once nothing is left auto-retriable. The **only**
human step is reviewing the PR the Release agent opens at the end — it lists
what was fixed, what's parked (failed twice — full attempt history attached),
and what's flagged (scope guard held it out of the merge).

**Known risk, not yet fixed:** the loop currently only routes back to `scan` via
the `deploy` edge. If a whole wave of tickets ends parked/flagged with none
deployed, the graph has no path back to `scan` and never reaches `release`.
There's also no cap on how many times the outer loop can run if triage keeps
surfacing tickets — needs fixing in `orchestrator/graph.ts` before a full
unattended run is trustworthy.

## What's real vs. what needs verification

- **Verified against the real target app and a real local Postgres:** Scanner
  (axe-core + Lighthouse; Pa11y currently crashes on this specific SPA — a
  `.replace()` error inside HTML CodeSniffer's injected runner, contained by
  `Promise.allSettled` so it doesn't break the rest of the scan, but
  contributes 0 findings), Triage (categorization, dedup, epic-per-cycle
  reuse), Developer's git-worktree mechanics (branch/worktree creation against
  the real repo).
- **Functional but gated on credentials, degrades gracefully:** Jira ticket
  creation, GitHub PR/merge/rollback-tag, Slack + email notifications.
- **Needs a sanity check before first run:** the Claude Agent SDK call sites in
  `development/developer-agent.ts` and `review/adversarial-review.ts`, the
  vision scan source, and the LangGraph API usage in `orchestrator/graph.ts` —
  all written from general knowledge of these libraries, not their live docs.
  Run `npm run fix -- --ticket <id>` on one ticket by hand first and fix any
  API-shape mismatches the compiler/runtime surfaces before trusting
  `npm run orchestrate` on a full cycle.
- **Never executed once:** the LangGraph orchestrator itself, and the
  ephemeral-preview build/serve path in `review/ephemeral-preview.ts`.
- **Test gate reality check:** `backend/package.json`'s `test` script is
  currently a placeholder (`exit 1`) and `frontend/package.json` has none at
  all — the Reviewer agent's test gate detects and skips this rather than
  blocking every fix forever, but it means the test gate isn't actually
  protecting anything yet. Add real tests to the target repo before relying on it.
- **No sandboxing beyond git worktrees.** Considered and deliberately removed —
  isolation currently relies on each ticket getting its own worktree directory,
  not container/process isolation. Fine for one ticket at a time; revisit if
  running tickets concurrently.

## Directory layout

```
src/
  types/, db/, lib/     shared Zod schemas, Drizzle schema/client, exec/notify/config utils
  integrations/         cross-cutting external adapters: jira.ts, github.ts, email.ts, observability.ts
  scan/                 axe-scan.ts (pure primitive), pa11y-scan.ts, vision-scan.ts,
                         scanner-agent.ts (DB-only path), tests/ (Playwright specs → a11y-reports/*.json)
  triage/               categorize.ts, triage-agent.ts (DB path), triage-from-reports.ts +
                         jira-scanner.ts (report/Jira-sync path used by orchestrate)
  development/          prompt-builder.ts, developer-agent.ts
  review/               scope-guard.ts, test-gate.ts, adversarial-review.ts,
                         ephemeral-preview.ts, reviewer-agent.ts
  deploy/, release/     deploy-agent.ts, release-agent.ts
  orchestrator/         the LangGraph graph wiring every agent into the autonomous loop
  cli/                  subcommands calling the same agent functions directly
```
