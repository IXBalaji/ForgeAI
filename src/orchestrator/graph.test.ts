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
vi.mock("../db/schema.js", () => ({ tickets: {}, iterationCycles: {} }));
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
vi.mock("../lib/config.js", () => ({ LABEL_PREFIX_SLUG: "test" }));

describe("routeAfterTriage", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns release when triage found no violations", async () => {
    const { routeAfterTriage } = await import("./graph.js");

    expect(routeAfterTriage({ cycleNumber: 0, triageFoundIssues: false } as any)).toBe("release");
    expect(routeAfterTriage({ cycleNumber: 0, triageFoundIssues: true } as any)).toBe("prepareBranch");
  });
});
