import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("dotenv/config", () => ({}));
function chainableSelect(rows: unknown[] = []) {
  return () => ({
    from: () => ({
      where: () => {
        // Thenable that's also chainable with .orderBy().limit() — reviewer
        // now queries fixAttempts both ways (direct await, and ordered for
        // "latest attempt").
        const thenable: any = Promise.resolve(rows);
        thenable.orderBy = () => ({ limit: () => Promise.resolve(rows.slice(0, 1)) });
        return thenable;
      },
    }),
  });
}
const insertValuesMock = vi.fn(() => ({ returning: () => Promise.resolve([{ id: "review-1" }]) }));
vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(chainableSelect([])),
    insert: vi.fn(() => ({ values: insertValuesMock })),
    update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve() }) })),
  },
}));
vi.mock("../db/schema.js", () => ({ fixAttempts: {}, tickets: {}, issues: {}, reviewResults: {} }));
vi.mock("../lib/exec.js", () => ({
  run: vi.fn().mockResolvedValue({ stdout: "src/a.ts\n", stderr: "" }),
}));
vi.mock("./scope-guard.js", () => ({ scopeGuard: vi.fn().mockResolvedValue({ flagged: false, reason: null }) }));
vi.mock("./test-gate.js", () => ({ testGate: vi.fn() }));
vi.mock("./ephemeral-preview.js", () => ({ startEphemeralPreview: vi.fn() }));
vi.mock("../scan/axe-scan.js", () => ({ runAxeScan: vi.fn(), fingerprintFinding: vi.fn() }));
vi.mock("../integrations/tracker/factory.js", () => ({ getTrackerProvider: () => ({ transitionTicket: vi.fn(), comment: vi.fn() }) }));
vi.mock("../lib/mutex.js", () => ({ gitRepoMutex: { acquire: vi.fn().mockResolvedValue(() => {}) } }));
vi.mock("../lib/audit-log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../observability/sanitize.js", () => ({ redactSecrets: (s: string) => s, sanitizeForTrace: (v: unknown) => v }));

describe("_reviewBranch (via reviewBranch)", () => {
  let addReviewCommentsMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    addReviewCommentsMock = vi.fn().mockResolvedValue("review-123");
    vi.doMock("../integrations/vcs/factory.js", () => ({
      getVcsProvider: () => ({ addReviewComments: addReviewCommentsMock }),
    }));
  });

  it("approves when tests pass and there are no blocking findings", async () => {
    const { testGate } = await import("./test-gate.js");
    vi.mocked(testGate).mockResolvedValue({ passed: true, output: "ok" } as any);
    vi.doMock("./adversarial-review.js", () => ({
      adversarialReview: vi.fn().mockResolvedValue([
        { severity: "suggestion", category: "style", file: "src/a.ts", line: 1, message: "nit" },
      ]),
    }));

    const { reviewBranch } = await import("./reviewer-agent.js");
    const result = await reviewBranch("/worktree", ["ticket-1"], 42, "cycle-1");

    expect(result.verdict).toBe("approved");
    expect(result.blockingFindingsCount).toBe(0);
    expect(addReviewCommentsMock).toHaveBeenCalledWith(42, expect.any(Array));
  });

  it("rejects when there is at least one blocking finding, even if tests pass", async () => {
    const { testGate } = await import("./test-gate.js");
    vi.mocked(testGate).mockResolvedValue({ passed: true, output: "ok" } as any);
    vi.doMock("./adversarial-review.js", () => ({
      adversarialReview: vi.fn().mockResolvedValue([
        { severity: "blocking", category: "security", file: "src/a.ts", line: 2, message: "XSS" },
      ]),
    }));

    const { reviewBranch } = await import("./reviewer-agent.js");
    const result = await reviewBranch("/worktree", ["ticket-1"], 42, "cycle-1");

    expect(result.verdict).toBe("rejected");
    expect(result.blockingFindingsCount).toBe(1);
  });

  it("rejects when tests fail regardless of findings", async () => {
    const { testGate } = await import("./test-gate.js");
    vi.mocked(testGate).mockResolvedValue({ passed: false, output: "build failed" } as any);
    vi.doMock("./adversarial-review.js", () => ({ adversarialReview: vi.fn().mockResolvedValue([]) }));

    const { reviewBranch } = await import("./reviewer-agent.js");
    const result = await reviewBranch("/worktree", ["ticket-1"], 42, "cycle-1");

    expect(result.verdict).toBe("rejected");
  });

  it("persists a review_results row against the ticket's latest fix_attempts row", async () => {
    const { testGate } = await import("./test-gate.js");
    vi.mocked(testGate).mockResolvedValue({ passed: true, output: "ok" } as any);
    vi.doMock("./adversarial-review.js", () => ({ adversarialReview: vi.fn().mockResolvedValue([]) }));
    const { db } = await import("../db/client.js");
    (db.select as any).mockImplementation(
      chainableSelect([{ id: "fix-attempt-1", ticketId: "ticket-1", branch: "b1", createdAt: new Date() }]),
    );
    insertValuesMock.mockClear();

    const { reviewBranch } = await import("./reviewer-agent.js");
    await reviewBranch("/worktree", ["ticket-1"], 42, "cycle-1");

    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ fixAttemptId: "fix-attempt-1", verdict: "approved" }));
  });

  it("does not call addReviewComments when there is no PR number", async () => {
    const { testGate } = await import("./test-gate.js");
    vi.mocked(testGate).mockResolvedValue({ passed: true, output: "ok" } as any);
    vi.doMock("./adversarial-review.js", () => ({
      adversarialReview: vi.fn().mockResolvedValue([
        { severity: "suggestion", category: "style", file: "src/a.ts", line: 1, message: "nit" },
      ]),
    }));

    const { reviewBranch } = await import("./reviewer-agent.js");
    await reviewBranch("/worktree", ["ticket-1"], null);

    expect(addReviewCommentsMock).not.toHaveBeenCalled();
  });
});
