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

describe("deployBranch pre-merge checklist (direct-to-qa, no PR)", () => {
  let vcsMock: any;
  let trackerMock: any;

  beforeEach(() => {
    vi.resetModules();
    vcsMock = {
      mergeBranch: vi.fn(),
      updateBranchFromBase: vi.fn(),
      isConflictError: () => false,
      createTag: vi.fn().mockResolvedValue("tag-1"),
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
    const result = await deployBranch("branch-1", ["t1"], "cycle-1");

    expect(result.status).toBe("blocked");
    expect(vcsMock.mergeBranch).not.toHaveBeenCalled();
  });

  it("blocks the merge when blocking findings remain", async () => {
    const state: any = {
      ticketRows: [{ id: "t1", jiraKey: "AB-1" }],
      fixAttemptRows: [{ id: "fa1", ticketId: "t1" }],
      reviewRows: [{ verdict: "approved", blockingFindingsCount: 2, resolvedIssueIds: [], comments: "" }],
      updates: [],
      inserted: [],
    };
    vi.doMock("../db/client.js", () => ({ db: buildFakeDb(state) }));

    const { deployBranch } = await import("./deploy-agent.js");
    const result = await deployBranch("branch-1", ["t1"], "cycle-1");

    expect(result.status).toBe("blocked");
    expect(result.blockReason).toMatch(/blocking/i);
    expect(vcsMock.mergeBranch).not.toHaveBeenCalled();
  });

  it("merges directly into qa when the checklist is clear", async () => {
    const state: any = {
      ticketRows: [{ id: "t1", jiraKey: "AB-1" }],
      fixAttemptRows: [{ id: "fa1", ticketId: "t1" }],
      reviewRows: [{ verdict: "approved", blockingFindingsCount: 0, resolvedIssueIds: [], comments: "" }],
      updates: [],
      inserted: [],
    };
    vi.doMock("../db/client.js", () => ({ db: buildFakeDb(state) }));
    vcsMock.mergeBranch.mockResolvedValue("merged-sha-123");

    const { deployBranch } = await import("./deploy-agent.js");
    const result = await deployBranch("branch-1", ["t1"], "cycle-1");

    expect(result.status).toBe("succeeded");
    expect(result.commitSha).toBe("merged-sha-123");
    expect(vcsMock.mergeBranch).toHaveBeenCalledWith("branch-1", expect.any(String), expect.any(String));
    // Tickets stay in whatever status they were — deployBranch itself never
    // marks "done"; that only happens once the verification scan confirms it.
    expect(state.updates.some((u: any) => u.values?.status === "done")).toBe(false);
    // The tracker should reflect "awaiting verification" so a ticket isn't
    // visibly stuck on "In Progress" all the way through to "Done".
    expect(trackerMock.transitionTicket).toHaveBeenCalledWith("AB-1", "In Review");
  });

  it("retries once via updateBranchFromBase on a merge conflict, then succeeds", async () => {
    const state: any = {
      ticketRows: [{ id: "t1", jiraKey: "AB-1" }],
      fixAttemptRows: [{ id: "fa1", ticketId: "t1" }],
      reviewRows: [{ verdict: "approved", blockingFindingsCount: 0, resolvedIssueIds: [], comments: "" }],
      updates: [],
      inserted: [],
    };
    vi.doMock("../db/client.js", () => ({ db: buildFakeDb(state) }));
    vcsMock.isConflictError = () => true;
    vcsMock.mergeBranch
      .mockRejectedValueOnce(new Error("conflict"))
      .mockResolvedValueOnce("merged-sha-456");

    const { deployBranch } = await import("./deploy-agent.js");
    const result = await deployBranch("branch-1", ["t1"], "cycle-1");

    expect(vcsMock.updateBranchFromBase).toHaveBeenCalledWith("branch-1", expect.any(String));
    expect(result.status).toBe("succeeded");
    expect(result.commitSha).toBe("merged-sha-456");
  });

  it("reopens tickets and fails when the merge cannot be completed", async () => {
    const state: any = {
      ticketRows: [{ id: "t1", jiraKey: "AB-1" }],
      fixAttemptRows: [{ id: "fa1", ticketId: "t1" }],
      reviewRows: [{ verdict: "approved", blockingFindingsCount: 0, resolvedIssueIds: [], comments: "" }],
      updates: [],
      inserted: [],
    };
    vi.doMock("../db/client.js", () => ({ db: buildFakeDb(state) }));
    vcsMock.mergeBranch.mockRejectedValue(new Error("hard failure"));

    const { deployBranch } = await import("./deploy-agent.js");
    const result = await deployBranch("branch-1", ["t1"], "cycle-1");

    expect(result.status).toBe("failed");
    expect(trackerMock.transitionTicket).toHaveBeenCalledWith("AB-1", "To Do");
    expect(state.updates.some((u: any) => u.table === TICKETS_TABLE && u.values?.status === "open")).toBe(true);
  });
});
