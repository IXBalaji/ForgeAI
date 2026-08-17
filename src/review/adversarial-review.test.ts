import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../lib/exec.js", () => ({ run: vi.fn() }));
vi.mock("../lib/config.js", () => ({ REVIEWER_MODEL: "test-model", REVIEWER_EFFORT: "low" }));

describe("adversarialReview", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.ANTHROPIC_API_KEY = "sk-test";
  });

  it("returns [] when ANTHROPIC_API_KEY is not set", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { adversarialReview } = await import("./adversarial-review.js");
    const findings = await adversarialReview("/some/dir");
    expect(findings).toEqual([]);
  });

  it("returns [] when the diff is empty", async () => {
    const { run } = await import("../lib/exec.js");
    vi.mocked(run).mockResolvedValue({ stdout: "   ", stderr: "" } as any);
    const { adversarialReview } = await import("./adversarial-review.js");
    const findings = await adversarialReview("/some/dir");
    expect(findings).toEqual([]);
  });

  it("parses structured JSON findings and classifies severity", async () => {
    const { run } = await import("../lib/exec.js");
    vi.mocked(run).mockResolvedValue({ stdout: "diff --git a/x.ts b/x.ts\n+broken", stderr: "" } as any);

    vi.doMock("../observability/anthropic-tracing.js", () => ({
      traceAnthropicAgentSdkQuery: vi.fn(async (opts: any) => {
        // Realistic SDK content-block shape: a thinking block (must be ignored)
        // followed by the text block carrying the actual JSON findings.
        opts.onAssistantMessage([
          { type: "thinking", thinking: "Let me analyze this diff carefully..." },
          {
            type: "text",
            text: JSON.stringify([
              { severity: "blocking", category: "security", file: "x.ts", line: 3, message: "XSS risk" },
              { severity: "suggestion", category: "style", file: "x.ts", line: 5, message: "naming nit" },
            ]),
          },
        ]);
      }),
    }));

    const { adversarialReview } = await import("./adversarial-review.js");
    const findings = await adversarialReview("/some/dir");
    expect(findings).toHaveLength(2);
    expect(findings.filter((f) => f.severity === "blocking")).toHaveLength(1);
    expect(findings[0].category).toBe("security");
  });

  it("treats an empty array response as LGTM", async () => {
    const { run } = await import("../lib/exec.js");
    vi.mocked(run).mockResolvedValue({ stdout: "diff content", stderr: "" } as any);

    vi.doMock("../observability/anthropic-tracing.js", () => ({
      traceAnthropicAgentSdkQuery: vi.fn(async (opts: any) => {
        opts.onAssistantMessage([{ type: "text", text: "[]" }]);
      }),
    }));

    const { adversarialReview } = await import("./adversarial-review.js");
    const findings = await adversarialReview("/some/dir");
    expect(findings).toEqual([]);
  });
});
