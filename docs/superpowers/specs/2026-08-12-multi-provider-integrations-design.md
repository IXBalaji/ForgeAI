# Multi-Provider VCS & Tracker Integrations — Design

## Context

ForgeAI is meant to be reused across target projects/clients (see `PROJECT_KEY` in `src/lib/config.ts`). Today it hardcodes two vendors:

- **Git hosting**: GitHub, via `src/integrations/github.ts` (REST API) *and* three separate hand-built `git` CLI auth URLs in `developer-agent.ts`, `conflict-resolver.ts`, and `graph.ts`.
- **Issue tracker**: Jira, via `src/integrations/jira.ts` (REST v3 API + JQL), with Jira's ADF rich-text format leaking into business logic in `ticket-builder.ts` and `triage-agent.ts`.

A prospective client wants Bitbucket or GitLab instead of GitHub, and a non-Jira tracker. Today that requires code changes in at least 8 files. This spec defines a provider-abstraction layer so that supporting a new VCS host or tracker is "write one adapter file + flip an env var" — no changes to pipeline/business-logic code.

**Explicitly in scope for this project:** the abstraction layer itself, plus `GitHubAdapter` and `JiraAdapter` as the two concrete, tested implementations (matching current behavior exactly).

**Explicitly out of scope:** building Bitbucket, GitLab, Linear, or Azure DevOps adapters. Those get written later, by implementing the interfaces defined here, when an actual client needs them — this spec's job is to make that a self-contained, low-risk addition instead of a cross-cutting change.

## Runtime model

One provider per deployment, selected once at startup via environment variables — matching the existing `PROJECT_KEY`-per-deployment model. No runtime provider switching within a single running instance.

```bash
# Client A's .env
VCS_PROVIDER=github
TRACKER_PROVIDER=jira

# Client B's .env (separate deployment)
VCS_PROVIDER=gitlab
TRACKER_PROVIDER=linear
```

## Directory structure

```
src/integrations/
  vcs/
    types.ts          # VcsProvider interface + shared types
    github.ts          # GitHubAdapter — today's github.ts, adapted to the interface
    factory.ts          # getVcsProvider() — reads VCS_PROVIDER env, returns singleton adapter
  tracker/
    types.ts          # TrackerProvider interface + TrackerIssue type
    jira.ts          # JiraAdapter — today's jira.ts + ticket-builder's ADF logic, merged in
    markdown-to-adf.ts    # pure converter: our neutral Markdown -> Jira's ADF (write path)
    adf-to-markdown.ts    # pure converter: Jira's ADF -> Markdown (read path, for search())
    factory.ts          # getTrackerProvider() — reads TRACKER_PROVIDER env
```

`src/integrations/github.ts` and `src/integrations/jira.ts` are removed; their logic moves into `vcs/github.ts` and `tracker/jira.ts` respectively, reshaped to implement the interfaces below.

Adding a new provider later means: one new file implementing the relevant interface, one new `case` in the matching `factory.ts`. Zero changes anywhere else.

## Config additions

`src/lib/config.ts` gains, alongside the existing per-agent model config:

```ts
export const VCS_PROVIDER = process.env.VCS_PROVIDER ?? "github";
export const TRACKER_PROVIDER = process.env.TRACKER_PROVIDER ?? "jira";
```

Defaults preserve current behavior exactly — existing deployments need no `.env` changes.

## `VcsProvider` interface

```ts
// src/integrations/vcs/types.ts
export interface VcsProvider {
  readonly name: string;
  isConfigured(): boolean;

  /** Merges `head` into `base`; returns the merge commit SHA, or null if not configured/no-op. */
  mergeBranch(head: string, base: string, commitMessage: string): Promise<string | null>;

  /** Merges `base` into `head` to bring a stale branch up to date before retrying a merge. */
  updateBranchFromBase(head: string, base: string): Promise<string | null>;

  /** Creates a lightweight tag at commitSha — the rollback marker. */
  createTag(tagName: string, commitSha: string): Promise<string | null>;

  /** True if `err` represents this provider's merge-conflict response, vs. a hard failure. */
  isConflictError(err: Error): boolean;

  /** Authenticated HTTPS remote URL for raw `git fetch`/`push` via child_process. Each host has its own token-auth URL scheme (GitHub: x-access-token, GitLab: oauth2, Bitbucket: x-token-auth or app-password). Returns null if not configured. */
  authenticatedRemoteUrl(): string | null;
}
```

### Why `authenticatedRemoteUrl()` matters most

This is the highest-value fix in the whole design. Today, `https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git` is hand-built **three separate times**:

- `developer-agent.ts` (`_runDeveloperAgent`, `_fixTicketOnBranch`)
- `conflict-resolver.ts` (`forcePushBranch`)
- `graph.ts` (`pushBranchNode`, `autofixNode`)

Each call site becomes:

```ts
const authRemote = vcs.authenticatedRemoteUrl();
if (authRemote) await run("git", ["remote", "set-url", "origin", authRemote], worktreeDir);
```

A future `GitLabAdapter`/`BitbucketAdapter` owns its own URL scheme entirely inside `authenticatedRemoteUrl()` — none of the three call sites change.

### `isConflictError()`

Replaces the current ad-hoc `/409|conflict|merge/i.test(errMsg)` regex duplicated in `deploy-agent.ts` and (implicitly) `conflict-resolver.ts`'s merge-attempt logic. Each provider phrases conflict failures differently (GitHub's merge API returns 409/405 with specific text; GitLab and Bitbucket differ) — centralizing this in the adapter means the classification logic travels with the provider, not with the caller.

### Deliberately excluded

`openPullRequest`/`mergePullRequest` exist in today's `github.ts` but have zero call sites — dead code from a PR-based flow that isn't used (the live deploy path is direct-merge via `mergeBranch`). Not part of this interface; add them if/when a real PR-based flow is built.

## `TrackerProvider` interface

```ts
// src/integrations/tracker/types.ts
export interface TrackerProvider {
  readonly name: string;
  isConfigured(): boolean;

  /** Returns (creating once, reusing thereafter) the parent epic/grouping issue for a remediation cycle. */
  ensureEpic(cycleId: string): Promise<string | null>;

  /** description is plain Markdown — the adapter serializes to its own native rich-text format on write. */
  createTicket(params: {
    epicKey: string | null;
    summary: string;
    description: string;
    labels: string[];
    priority?: "P1" | "P2" | "P3" | "P4";
  }): Promise<string | null>;

  updateTicket(params: {
    key: string;
    summary?: string;
    description?: string;
    labels?: string[];
    priority?: "P1" | "P2" | "P3" | "P4";
  }): Promise<void>;

  /** Dedup check on triage re-runs — finds an existing open ticket matching a summary prefix + labels. */
  findExisting(params: { summaryPrefix: string; labels: string[] }): Promise<string | null>;

  /** Moves a ticket to a named workflow status ("In Progress", "Done", "To Do") — matched case-insensitively against whatever this tracker calls its states/transitions. */
  transitionTicket(key: string, statusName: string): Promise<void>;

  /** body is plain Markdown. */
  comment(key: string, body: string): Promise<void>;

  /** Neutral query — no JQL (or any provider query language) leaks past this interface. */
  search(query: { labels?: string[]; excludeStatus?: string[] }, maxResults?: number): Promise<TrackerIssue[]>;
}

export interface TrackerIssue {
  key: string;
  summary: string;
  descriptionMarkdown: string;
  priority?: string;
  parentKey?: string | null;
}
```

### Markdown as the neutral rich-text format

Descriptions/comments cross the interface as plain Markdown, not Jira's ADF (Atlassian Document Format). `JiraAdapter` is the only place that knows ADF exists — it converts Markdown→ADF on write (`markdown-to-adf.ts`) and ADF→Markdown on read (`adf-to-markdown.ts`, used by `search()`).

This forces two real simplifications, not just abstraction for its own sake:

1. **`ticket-builder.ts` and `triage-agent.ts` stop hand-building ADF node trees.** Their `paragraph`/`heading`/`bulletList`/`table`/`codeBlock` helper functions (constructing `{type: "doc", version: 1, content: [...]}` structures) are replaced by plain Markdown string templates — fewer types, less code, and it reads the same in any tracker's native UI (GitHub Issues, GitLab, Linear, Jira all render Markdown reasonably).
2. **`jira-scanner.ts`'s reverse-sync gets simpler.** `parseJiraIssue` today walks raw ADF nodes to recover the WCAG rule/impact/page data it wrote into the description earlier (`extractRuleIdFromAdf`, `extractImpactFromAdf`, `extractPagesFromAdf`). With `search()` returning `descriptionMarkdown`, this becomes parsing our own Markdown template — a fixed, simple format we control, independent of tracker vendor.

### `transitionTicket` status names

Kept as free-text status names ("In Progress", "Done", "To Do") rather than provider-specific transition IDs — this already matches how `jira.ts` works today (case-insensitive name lookup against available transitions), so it's carried forward unchanged rather than "fixed."

### `tickets.jiraKey` DB column

**Not renamed.** Confirmed with the client: the migration cost isn't worth it given the column is purely an internal storage detail once hidden behind `TrackerProvider`. `JiraAdapter` (and any future adapter) maps its own concept of "ticket key" onto this field name; the naming mismatch is contained to one line of intent, not a functional issue.

## Factories

```ts
// src/integrations/vcs/factory.ts
import { VCS_PROVIDER } from "../../lib/config.js";
import type { VcsProvider } from "./types.js";
import { GitHubAdapter } from "./github.js";

let instance: VcsProvider | null = null;

export function getVcsProvider(): VcsProvider {
  if (instance) return instance;
  switch (VCS_PROVIDER) {
    case "github":
      instance = new GitHubAdapter();
      break;
    default:
      throw new Error(`Unknown VCS_PROVIDER "${VCS_PROVIDER}"`);
  }
  return instance;
}
```

`src/integrations/tracker/factory.ts` mirrors this exactly with `getTrackerProvider()` / `TRACKER_PROVIDER` / `JiraAdapter`.

Both factories memoize a singleton (matches the stateless-module pattern `github.ts`/`jira.ts` already use — one process, one provider, no need to reconstruct per call).

## Migration — call sites touched

All of these are **behavior-preserving swaps** — replace a direct `github.js`/`jira.js` import with a factory call, no logic changes beyond that:

| File | Change |
|---|---|
| `developer-agent.ts` | inline auth-URL construction (×2) → `vcs.authenticatedRemoteUrl()`; `transitionTicket` → `tracker.transitionTicket` |
| `conflict-resolver.ts` | inline auth-URL construction → `vcs.authenticatedRemoteUrl()` |
| `graph.ts` | inline auth-URL construction (×2, `pushBranchNode`/`autofixNode`) → `vcs.authenticatedRemoteUrl()`; `ensureEpic` → `tracker.ensureEpic` |
| `deploy-agent.ts` | `mergeBranch`/`createTag`/`updateBranchFromBase` → `vcs.*`; `transitionTicket`/`commentOnTicket` → `tracker.*`; conflict-detection regex → `vcs.isConflictError()` |
| `reviewer-agent.ts` | `transitionTicket` → `tracker.transitionTicket` |
| `triage-agent.ts` | ADF builder helpers → Markdown string-building; `createTriagedTicket`/`updateJiraTicket`/`transitionTicket` → `tracker.*` |
| `triage-from-reports.ts` | `ensureEpic`/`createTriagedTicket`/`findExistingJiraTicket`/`updateJiraTicket`/`transitionTicket` → `tracker.*` |
| `ticket-builder.ts` | ADF node builders → Markdown string templates; `JiraTicketPayload.description` becomes `string` (Markdown) instead of the ADF document type |
| `jira-scanner.ts` | `searchTickets(jql)` → `tracker.search({labels, excludeStatus})`; ADF-walking `parseJiraIssue` → Markdown parsing |

New files: `vcs/{types,github,factory}.ts`, `tracker/{types,jira,markdown-to-adf,adf-to-markdown,factory}.ts`.
Removed files: `integrations/github.ts`, `integrations/jira.ts` (logic relocated, not deleted outright).

## Error handling

- Adapters preserve today's error-message convention: `` `${provider} API ${method} ${path} failed: ${status} ${body}` ``. Nothing downstream that logs or greps error text changes behavior.
- `VcsProvider.isConflictError()` centralizes merge-conflict classification that's currently inline regex in `deploy-agent.ts`.
- Unconfigured providers keep today's behavior: adapter methods return `null`/no-op with a `console.warn`, never throw — call sites don't need to change their "GitHub/Jira not configured" handling.

## Testing

- **New unit tests** (the actual novel logic in this design):
  - `GitHubAdapter.authenticatedRemoteUrl()` — correct URL construction, `null` when unconfigured
  - `markdown-to-adf.ts` / `adf-to-markdown.ts` — round-trip test (Markdown → ADF → Markdown preserves headings/lists/tables/code blocks used by `ticket-builder.ts`)
  - `JiraAdapter.transitionTicket()` — case-insensitive status-name matching (already-tested behavior, carried forward)
- **Call-site swap files** (`deploy-agent.ts`, `graph.ts`, etc.) get no new tests — this is a mechanical re-routing of existing calls, verified via `npm run build`/`tsc --noEmit` and a manual run against a real target repo before merging.

## Rollout

Zero-touch for current deployments: `VCS_PROVIDER=github` and `TRACKER_PROVIDER=jira` are the defaults, matching today's only-ever-used configuration. A new client on Bitbucket/GitLab or a non-Jira tracker requires: implement the relevant interface in a new adapter file, register it in the factory's `switch`, set the env var. No pipeline code changes.

## Explicitly deferred (not part of this project)

- Concrete `BitbucketAdapter`, `GitLabAdapter`, and any non-Jira `TrackerProvider` implementation — built when an actual client needs one, using this spec's interfaces.
- Runtime/multi-tenant provider switching within a single deployment — not needed; confirmed one-provider-per-deployment matches actual usage.
- Renaming `tickets.jiraKey` — confirmed not worth the migration cost right now.
- Reviving `openPullRequest`/`mergePullRequest` (PR-based deploy flow) — currently dead code, out of scope.
