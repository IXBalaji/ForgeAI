import { describe, expect, it, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

vi.mock("dotenv/config", () => ({}));

const TICKETS_TABLE = { __name: "tickets" };
const ISSUES_TABLE = { __name: "issues" };
const SCAN_RUNS_TABLE = { __name: "scan_runs" };

vi.mock("../db/schema.js", () => ({
  scanRuns: SCAN_RUNS_TABLE,
  issues: ISSUES_TABLE,
  tickets: TICKETS_TABLE,
}));
vi.mock("../lib/config.js", () => ({ LABEL_PREFIX: "TEST" }));
vi.mock("./categorize.js", () => ({ categorize: (ruleId: string) => `category:${ruleId}` }));

function fingerprintOf(ruleId: string, selector: string, pageUrl: string): string {
  return crypto.createHash("sha256").update(`${ruleId}:${selector}:${pageUrl}`).digest("hex");
}

interface FakeState {
  ticketRows: any[];
  issueRows: any[];
  ticketUpdates: Array<{ where: any; values: any }>;
  issueUpdates: Array<{ where: any; values: any }>;
}

function buildFakeDb(state: FakeState) {
  return {
    select: () => ({
      from: (table: any) => ({
        where: () => {
          if (table === TICKETS_TABLE) return Promise.resolve(state.ticketRows);
          if (table === ISSUES_TABLE) return Promise.resolve(state.issueRows);
          return Promise.resolve([]);
        },
        limit: () => Promise.resolve([]),
      }),
    }),
    update: (table: any) => ({
      set: (values: any) => ({
        where: (whereArg: any) => {
          if (table === TICKETS_TABLE) state.ticketUpdates.push({ where: whereArg, values });
          if (table === ISSUES_TABLE) state.issueUpdates.push({ where: whereArg, values });
          return Promise.resolve();
        },
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([{ id: "scan-run-1" }]),
        onConflictDoNothing: () => ({ returning: () => Promise.resolve([]) }),
      }),
    }),
  };
}

describe("triageFromReports — per-ticket fingerprint verification", () => {
  let trackerMock: any;
  let confirmTicketFixedMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    trackerMock = { ensureEpic: vi.fn().mockResolvedValue("EPIC-1"), transitionTicket: vi.fn(), comment: vi.fn() };
    confirmTicketFixedMock = vi.fn();
    vi.doMock("../integrations/tracker/factory.js", () => ({ getTrackerProvider: () => trackerMock }));
    vi.doMock("../deploy/deploy-agent.js", () => ({ confirmTicketFixed: confirmTicketFixedMock }));
  });

  it("marks an in_review ticket done when none of its issues reproduce in the fresh scan", async () => {
    vi.doMock("./report-reader.js", () => ({
      readReportDir: () => [],
      aggregateByRule: () => [],
    }));
    vi.doMock("./issue-classifier.js", () => ({ classifyIssues: vi.fn() }));
    vi.doMock("./ticket-builder.js", () => ({ buildTicketPayloads: vi.fn() }));

    const state: FakeState = {
      ticketRows: [{ id: "ticket-1", jiraKey: "AB-1", category: "category:label", issueIds: ["issue-1"], status: "in_review" }],
      issueRows: [{ id: "issue-1", fingerprint: fingerprintOf("label", "#email", "https://example.com/signup") }],
      ticketUpdates: [],
      issueUpdates: [],
    };
    vi.doMock("../db/client.js", () => ({ db: buildFakeDb(state) }));

    const { triageFromReports } = await import("./triage-from-reports.js");
    const result = await triageFromReports({ cycleId: "cycle-1", epicKey: "EPIC-1" });

    expect(confirmTicketFixedMock).toHaveBeenCalledWith("ticket-1");
    expect(state.issueUpdates).toContainEqual(expect.objectContaining({ values: { status: "resolved" } }));
    expect(result.summary.totalViolationTypes).toBe(0);
  });

  it("reopens an in_review ticket with only the still-failing issues when some reproduce", async () => {
    const ruleId = "label";
    const selector = "#email";
    const pageUrl = "https://example.com/signup";
    const stillFailingFingerprint = fingerprintOf(ruleId, selector, pageUrl);
    const resolvedFingerprint = fingerprintOf("color-contrast", "#footer", "https://example.com/about");

    vi.doMock("./report-reader.js", () => ({
      readReportDir: () => [],
      aggregateByRule: () => [
        {
          ruleId,
          impact: "serious",
          affectedPages: [{ url: pageUrl, fileSlug: "signup", nodes: [{ target: [selector], html: "", failureSummary: null, impact: "serious" }] }],
          totalNodeCount: 1,
        },
      ],
    }));
    vi.doMock("./issue-classifier.js", () => ({ classifyIssues: vi.fn().mockImplementation((issues: any[]) => issues) }));
    vi.doMock("./ticket-builder.js", () => ({ buildTicketPayloads: vi.fn().mockReturnValue([]) }));

    const state: FakeState = {
      ticketRows: [{ id: "ticket-1", jiraKey: "AB-1", category: "category:label", issueIds: ["issue-still-failing", "issue-resolved"], status: "in_review" }],
      issueRows: [
        { id: "issue-still-failing", fingerprint: stillFailingFingerprint },
        { id: "issue-resolved", fingerprint: resolvedFingerprint },
      ],
      ticketUpdates: [],
      issueUpdates: [],
    };
    vi.doMock("../db/client.js", () => ({ db: buildFakeDb(state) }));

    const { triageFromReports } = await import("./triage-from-reports.js");
    await triageFromReports({ cycleId: "cycle-1", epicKey: "EPIC-1" });

    expect(confirmTicketFixedMock).not.toHaveBeenCalled();
    expect(state.ticketUpdates).toContainEqual(
      expect.objectContaining({ values: { status: "open", issueIds: ["issue-still-failing"] } }),
    );
    expect(trackerMock.transitionTicket).toHaveBeenCalledWith("AB-1", "To Do");
  });
});
