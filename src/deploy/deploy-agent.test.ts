import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("dotenv/config", () => ({}));
vi.mock("./conflict-resolver.js", () => ({ resolveConflicts: vi.fn() }));
vi.mock("../lib/audit-log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../lib/config.js", () => ({ LABEL_PREFIX_SLUG: "test" }));
const TICKETS_TABLE = { __name: "tickets" };
const FIX_ATTEMPTS_TABLE = { __name: "fix_attempts" };
const REVIEW_RESULTS_TABLE = { __name: "review_results" };
const DEPLOYMENTS_TABLE = { __name: "deployments" };

vi.mock("../db/schema.js", () => ({
  fixAttempts: FIX_ATTEMPTS_TABLE,
  tickets: TICKETS_TABLE,
  deployments: DEPLOYMENTS_TABLE,
  reviewResults: REVIEW_RESULTS_TABLE,
}));

interface FakeDbState {
  ticketRows: any[];
  fixAttemptRows: any[];
  reviewRows: any[];
  updates: Array<{ table: any; values: any }>;
  inserted: any[];
}

function buildFakeDb(state: FakeDbState) {
  return {
    select: () => ({
      from: (table: any) => ({
        where: (..._args: any[]) => {
          const rows =
            table === TICKETS_TABLE ? state.ticketRows : table === FIX_ATTEMPTS_TABLE ? state.fixAttemptRows : state.reviewRows;
          // Thenable that's also chainable with .orderBy().limit() — deploy-agent
          // queries reviewResults both ways (checkMergeReadiness chains, the
          // postResolutionComment path awaits `.where()` directly).
          const thenable: any = Promise.resolve(rows);
          thenable.orderBy = () => ({ limit: () => Promise.resolve(rows.slice(0, 1)) });
          return thenable;
        },
      }),
    }),
    update: (table: any) => ({
      set: (values: any) => ({
        where: () => {
          state.updates.push({ table, values });
          return Promise.resolve();
        },
      }),
    }),
    insert: () => ({
      values: (values: any) => ({
        returning: () => {
          const row = { id: `deployment-${state.inserted.length}`, ...values };
          state.inserted.push(row);
          return Promise.resolve([row]);
        },
      }),
    }),
  };
}

describe("deployBranch pre-merge checklist", () => {
  let vcsMock: any;
  let trackerMock: any;

  beforeEach(() => {
    vi.resetModules();
    vcsMock = {
      getPullRequestStatus: vi.fn(),
      mergePullRequest: vi.fn(),
      updateBranchFromBase: vi.fn(),
      isConflictError: () => false,
      createTag: vi.fn().mockResolvedValue("tag-1"),
      requestChanges: vi.fn(),
    };
    trackerMock = { transitionTicket: vi.fn(), comment: vi.fn() };
    vi.doMock("../integrations/vcs/factory.js", () => ({ getVcsProvider: () => vcsMock }));
    vi.doMock("../integrations/tracker/factory.js", () => ({ getTrackerProvider: () => trackerMock }));
  });

  it("blocks the merge when the latest review is not approved", async () => {
    const state: any = {
      ticketRows: [{ id: "t1", jiraKey: "AB-1" }],
      fixAttemptRows: [{ id: "fa1", ticketId: "t1" }],
      reviewRows: [{ verdict: "rejected", blockingFindingsCount: 0, resolvedIssueIds: [], comments: "" }],
      updates: [],
      inserted: [],
    };
    vi.doMock("../db/client.js", () => ({ db: buildFakeDb(state) }));

    const { deployBranch } = await import("./deploy-agent.js");
    const result = await deployBranch("branch-1", ["t1"], 10, "https://github.com/o/r/pull/10", "cycle-1");

    expect(result.status).toBe("blocked");
    expect(vcsMock.mergePullRequest).not.toHaveBeenCalled();
  });

  it("blocks the merge when blocking findings remain", async () => {
    const state: any = {
      ticketRowsTable: {},
      fixAttemptRowsTable: {},
      ticketRows: [{ id: "t1", jiraKey: "AB-1" }],
      fixAttemptRows: [{ id: "fa1", ticketId: "t1" }],
      reviewRows: [{ verdict: "approved", blockingFindingsCount: 2, resolvedIssueIds: [], comments: "" }],
      updates: [],
      inserted: [],
    };
    vi.doMock("../db/client.js", () => ({ db: buildFakeDb(state) }));

    const { deployBranch } = await import("./deploy-agent.js");
    const result = await deployBranch("branch-1", ["t1"], 10, null, "cycle-1");

    expect(result.status).toBe("blocked");
    expect(result.blockReason).toMatch(/blocking/i);
  });

  it("blocks the merge when GitHub review state is not APPROVED", async () => {
    const state: any = {
      ticketRowsTable: {},
      fixAttemptRowsTable: {},
      ticketRows: [{ id: "t1", jiraKey: "AB-1" }],
      fixAttemptRows: [{ id: "fa1", ticketId: "t1" }],
      reviewRows: [{ verdict: "approved", blockingFindingsCount: 0, resolvedIssueIds: [], comments: "" }],
      updates: [],
      inserted: [],
    };
    vi.doMock("../db/client.js", () => ({ db: buildFakeDb(state) }));
    vcsMock.getPullRequestStatus.mockResolvedValue({ merged: false, reviewState: "CHANGES_REQUESTED", mergeable: true });

    const { deployBranch } = await import("./deploy-agent.js");
    const result = await deployBranch("branch-1", ["t1"], 10, null, "cycle-1");

    expect(result.status).toBe("blocked");
    expect(vcsMock.mergePullRequest).not.toHaveBeenCalled();
  });

  it("blocks the merge on conflicts", async () => {
    const state: any = {
      ticketRowsTable: {},
      fixAttemptRowsTable: {},
      ticketRows: [{ id: "t1", jiraKey: "AB-1" }],
      fixAttemptRows: [{ id: "fa1", ticketId: "t1" }],
      reviewRows: [{ verdict: "approved", blockingFindingsCount: 0, resolvedIssueIds: [], comments: "" }],
      updates: [],
      inserted: [],
    };
    vi.doMock("../db/client.js", () => ({ db: buildFakeDb(state) }));
    vcsMock.getPullRequestStatus.mockResolvedValue({ merged: false, reviewState: "APPROVED", mergeable: false, mergeableState: "dirty" });

    const { deployBranch } = await import("./deploy-agent.js");
    const result = await deployBranch("branch-1", ["t1"], 10, null, "cycle-1");

    expect(result.status).toBe("blocked");
    expect(vcsMock.mergePullRequest).not.toHaveBeenCalled();
  });

  it("merges when all checklist conditions are clear", async () => {
    const state: any = {
      ticketRowsTable: {},
      fixAttemptRowsTable: {},
      ticketRows: [{ id: "t1", jiraKey: "AB-1" }],
      fixAttemptRows: [{ id: "fa1", ticketId: "t1" }],
      reviewRows: [{ verdict: "approved", blockingFindingsCount: 0, resolvedIssueIds: [], comments: "" }],
      updates: [],
      inserted: [],
    };
    vi.doMock("../db/client.js", () => ({ db: buildFakeDb(state) }));
    vcsMock.getPullRequestStatus.mockResolvedValue({ merged: false, reviewState: "APPROVED", mergeable: true, mergeableState: "clean" });
    vcsMock.mergePullRequest.mockResolvedValue("merged-sha-123");

    const { deployBranch } = await import("./deploy-agent.js");
    const result = await deployBranch("branch-1", ["t1"], 10, "https://github.com/o/r/pull/10", "cycle-1");

    expect(result.status).toBe("succeeded");
    expect(result.commitSha).toBe("merged-sha-123");
    expect(vcsMock.mergePullRequest).toHaveBeenCalledWith(10, "merge");
  });

  it("merges a self-authored PR without requiring a GitHub-side APPROVED review", async () => {
    const state: any = {
      ticketRowsTable: {},
      fixAttemptRowsTable: {},
      ticketRows: [{ id: "t1", jiraKey: "AB-1" }],
      fixAttemptRows: [{ id: "fa1", ticketId: "t1" }],
      reviewRows: [{ verdict: "approved", blockingFindingsCount: 0, resolvedIssueIds: [], comments: "" }],
      updates: [],
      inserted: [],
    };
    vi.doMock("../db/client.js", () => ({ db: buildFakeDb(state) }));
    // GitHub refuses to record an APPROVED review when the PR author and the
    // API token are the same identity — reviewState stays "NONE" forever.
    vcsMock.getPullRequestStatus.mockResolvedValue({ merged: false, reviewState: "NONE", mergeable: true, mergeableState: "clean", selfAuthored: true });
    vcsMock.mergePullRequest.mockResolvedValue("merged-sha-456");

    const { deployBranch } = await import("./deploy-agent.js");
    const result = await deployBranch("branch-1", ["t1"], 10, "https://github.com/o/r/pull/10", "cycle-1");

    expect(result.status).toBe("succeeded");
    expect(vcsMock.mergePullRequest).toHaveBeenCalledWith(10, "merge");
  });

  it("skips re-merging when the PR was already merged (idempotent resume)", async () => {
    const state: any = {
      ticketRowsTable: {},
      fixAttemptRowsTable: {},
      ticketRows: [{ id: "t1", jiraKey: "AB-1" }],
      fixAttemptRows: [{ id: "fa1", ticketId: "t1" }],
      reviewRows: [{ verdict: "approved", blockingFindingsCount: 0, resolvedIssueIds: [], comments: "" }],
      updates: [],
      inserted: [],
    };
    vi.doMock("../db/client.js", () => ({ db: buildFakeDb(state) }));
    vcsMock.getPullRequestStatus.mockResolvedValue({ merged: true, headSha: "already-merged-sha" });

    const { deployBranch } = await import("./deploy-agent.js");
    const result = await deployBranch("branch-1", ["t1"], 10, null, "cycle-1");

    expect(result.status).toBe("succeeded");
    expect(vcsMock.mergePullRequest).not.toHaveBeenCalled();
  });
});
