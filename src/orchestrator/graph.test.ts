import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("dotenv/config", () => ({}));
vi.mock("@langchain/langgraph", () => {
  const Annotation = Object.assign(
    (config: any) => config,
    { Root: (config: any) => config },
  );

  return {
    StateGraph: class {
      addNode() { return this; }
      addEdge() { return this; }
      addConditionalEdges() { return this; }
      compile() { return { invoke: vi.fn() }; }
    },
    Annotation,
    START: "START",
    END: "END",
  };
});
vi.mock("@langchain/langgraph-checkpoint-postgres", () => ({
  PostgresSaver: { fromConnString: () => ({ setup: vi.fn() }) },
}));
vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../db/schema.js", () => ({ tickets: {}, issues: {}, iterationCycles: {}, fixAttempts: {}, reportsGenerated: {} }));
vi.mock("../triage/triage-from-reports.js", () => ({ triageFromReports: vi.fn() }));
vi.mock("../development/developer-agent.js", () => ({
  fixTicketOnBranch: vi.fn(),
  fixBuildErrors: vi.fn(),
}));
vi.mock("../review/reviewer-agent.js", () => ({ reviewBranch: vi.fn() }));
vi.mock("../deploy/deploy-agent.js", () => ({ deployBranch: vi.fn() }));
vi.mock("../release/release-agent.js", () => ({ runReleaseAgent: vi.fn() }));
vi.mock("../integrations/tracker/factory.js", () => ({ getTrackerProvider: () => ({ ensureEpic: vi.fn() }) }));
vi.mock("../integrations/vcs/factory.js", () => ({ getVcsProvider: () => ({ authenticatedRemoteUrl: () => null }) }));
vi.mock("../integrations/observability.js", () => ({ withSpan: async (_name: string, fn: () => any) => fn(), initObservability: vi.fn() }));
vi.mock("../observability/agent-tracing.js", () => ({ runAgentTrace: async (_name: string, fn: () => any) => fn() }));
vi.mock("../observability/anthropic-tracing.js", () => ({ runIssueResolutionPipeline: async (_name: string, fn: () => any) => fn() }));
vi.mock("../observability/pipeline-context.js", () => ({ runWithPipelineContext: async (_ctx: any, fn: () => any) => fn(), setPipelineCycleNumber: vi.fn() }));
vi.mock("../observability/silent-langgraph-tracer.js", () => ({ SilentLangGraphTracer: class {} }));
vi.mock("../lib/exec.js", () => ({ run: vi.fn() }));
vi.mock("../lib/mutex.js", () => ({ gitRepoMutex: { acquire: vi.fn() } }));
vi.mock("../lib/retry.js", () => ({ withRetry: async (fn: () => any) => fn() }));
vi.mock("../lib/audit-log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../lib/notify.js", () => ({ notifyUnrecoverableError: vi.fn() }));
vi.mock("../integrations/email.js", () => ({ sendEmail: vi.fn() }));
vi.mock("../integrations/report-template.js", () => ({ renderPreProcessEmailHtml: vi.fn(), renderPreProcessEmailText: vi.fn() }));
vi.mock("../lib/config.js", () => ({ LABEL_PREFIX_SLUG: "test", LABEL_PREFIX: "TEST", JIRA_BASE_URL: null }));

describe("routeAfterTriage", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns release once every ticket tied to this cycle's epic is done/parked/flagged", async () => {
    vi.doMock("../db/client.js", () => ({
      db: { select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) },
    }));
    const { routeAfterTriage } = await import("./graph.js");
    const result = await routeAfterTriage({ cycleId: "cycle-1", cycleNumber: 0, epicKey: "EPIC-1" } as any);
    expect(result).toBe("release");
  });

  it("continues fixing while this cycle still has unresolved (open/in_review) tickets", async () => {
    vi.doMock("../db/client.js", () => ({
      db: { select: () => ({ from: () => ({ where: () => Promise.resolve([{ id: "t1" }]) }) }) },
    }));
    const { routeAfterTriage } = await import("./graph.js");
    const result = await routeAfterTriage({ cycleId: "cycle-1", cycleNumber: 0, epicKey: "EPIC-1" } as any);
    expect(result).toBe("preProcessEmail");
  });

  it("releases once MAX_CYCLES is reached regardless of unresolved tickets", async () => {
    vi.doMock("../db/client.js", () => ({
      db: { select: () => ({ from: () => ({ where: () => Promise.resolve([{ id: "t1" }]) }) }) },
    }));
    const { routeAfterTriage } = await import("./graph.js");
    const result = await routeAfterTriage({ cycleId: "cycle-1", cycleNumber: 20, epicKey: "EPIC-1" } as any);
    expect(result).toBe("release");
  });

  it("stops at preProcessEmail for 'triage' mode even when every ticket is already resolved", async () => {
    // Simulates the edge case where this triage pass found zero new
    // violations and every ticket happens to already be "done" from an
    // earlier full-mode run — triage mode must never fall through to release.
    vi.doMock("../db/client.js", () => ({
      db: { select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) },
    }));
    const { routeAfterTriage } = await import("./graph.js");
    const result = await routeAfterTriage({ cycleId: "cycle-1", cycleNumber: 0, mode: "triage", epicKey: "EPIC-1" } as any);
    expect(result).toBe("preProcessEmail");
  });
});

describe("routeAfterScan", () => {
  it("stops at 'finish' for 'scan' mode", async () => {
    const { routeAfterScan } = await import("./graph.js");
    expect(routeAfterScan({ mode: "scan" } as any)).toBe("finish");
  });

  it("continues to triage for 'triage' and 'full' modes", async () => {
    const { routeAfterScan } = await import("./graph.js");
    expect(routeAfterScan({ mode: "triage" } as any)).toBe("triage");
    expect(routeAfterScan({ mode: "full" } as any)).toBe("triage");
  });
});

describe("routeAfterPreProcessEmail", () => {
  it("stops at 'finish' for 'triage' mode (no fixing attempted)", async () => {
    const { routeAfterPreProcessEmail } = await import("./graph.js");
    expect(routeAfterPreProcessEmail({ mode: "triage" } as any)).toBe("finish");
  });

  it("continues to prepareBranch for 'full' mode", async () => {
    const { routeAfterPreProcessEmail } = await import("./graph.js");
    expect(routeAfterPreProcessEmail({ mode: "full" } as any)).toBe("prepareBranch");
  });
});
