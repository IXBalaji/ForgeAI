import { describe, expect, it, vi } from "vitest";

vi.mock("dotenv/config", () => ({}));
vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../db/schema.js", () => ({
  tickets: {}, iterationCycles: {}, fixAttempts: {}, reviewResults: {}, deployments: {}, reportsGenerated: {},
}));
vi.mock("../lib/notify.js", () => ({ notifySlack: vi.fn() }));
vi.mock("../lib/audit-log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../integrations/email.js", () => ({ sendEmail: vi.fn() }));
vi.mock("../integrations/report-template.js", () => ({
  renderPostProcessEmailHtml: vi.fn(),
  renderPostProcessEmailText: vi.fn(),
}));
vi.mock("./final-report.js", () => ({ generateFinalReport: vi.fn() }));
vi.mock("../lib/config.js", () => ({ LABEL_PREFIX: "TEST" }));
vi.mock("../integrations/vcs/factory.js", () => ({ getVcsProvider: () => ({ createPullRequest: vi.fn() }) }));

describe("categorizeCycleFailure", () => {
  it("categorizes a ConfigError as config", async () => {
    const { categorizeCycleFailure } = await import("./failure-category.js");
    const { ConfigError } = await import("../lib/preflight.js");
    const result = categorizeCycleFailure(new ConfigError(["PROJECT_KEY is not set."]));
    expect(result.category).toBe("config");
    expect(result.reason).toContain("PROJECT_KEY");
  });

  it("categorizes a JiraAuthError as jira-auth", async () => {
    const { categorizeCycleFailure } = await import("./failure-category.js");
    const { JiraAuthError } = await import("../integrations/tracker/errors.js");
    const result = categorizeCycleFailure(new JiraAuthError(401, "/rest/api/3/issue/PROJ-1"));
    expect(result.category).toBe("jira-auth");
  });

  it("categorizes a GitHubAuthError as github-auth", async () => {
    const { categorizeCycleFailure } = await import("./failure-category.js");
    const { GitHubAuthError } = await import("../integrations/vcs/errors.js");
    const result = categorizeCycleFailure(new GitHubAuthError(401, "/user"));
    expect(result.category).toBe("github-auth");
  });

  it("categorizes a GitNotCleanError as git-precondition", async () => {
    const { categorizeCycleFailure } = await import("./failure-category.js");
    const { GitNotCleanError } = await import("../lib/repo-config.js");
    const result = categorizeCycleFailure(new GitNotCleanError(["M src/foo.ts"]));
    expect(result.category).toBe("git-precondition");
  });

  it("categorizes a GitNotSyncedError as git-precondition", async () => {
    const { categorizeCycleFailure } = await import("./failure-category.js");
    const { GitNotSyncedError } = await import("../lib/repo-config.js");
    const result = categorizeCycleFailure(new GitNotSyncedError("qa", "behind"));
    expect(result.category).toBe("git-precondition");
  });

  it("categorizes a ReleaseError as release", async () => {
    const { categorizeCycleFailure } = await import("./failure-category.js");
    const { ReleaseError } = await import("../release/release-agent.js");
    const result = categorizeCycleFailure(new ReleaseError("Pull request could not be created: boom"));
    expect(result.category).toBe("release");
  });

  it("falls back to internal for an unrecognized Error", async () => {
    const { categorizeCycleFailure } = await import("./failure-category.js");
    const result = categorizeCycleFailure(new Error("connection reset"));
    expect(result.category).toBe("internal");
    expect(result.reason).toBe("connection reset");
  });

  it("stringifies a non-Error thrown value and still categorizes it internal", async () => {
    const { categorizeCycleFailure } = await import("./failure-category.js");
    const result = categorizeCycleFailure("plain string throw");
    expect(result.category).toBe("internal");
    expect(result.reason).toBe("plain string throw");
  });
});

describe("formatCycleFailedSentinel", () => {
  it("collapses a multi-line reason onto a single sentinel line", async () => {
    const { formatCycleFailedSentinel } = await import("./failure-category.js");
    const reason = "Configuration is incomplete:\n  - PROJECT_KEY is not set.\n  - DATABASE_URL is not set.";
    const sentinel = formatCycleFailedSentinel("config", reason);

    expect(sentinel.split("\n")).toHaveLength(1);
    expect(sentinel).toBe(
      "CYCLE_FAILED: config | Configuration is incomplete: - PROJECT_KEY is not set. - DATABASE_URL is not set.",
    );
  });

  it("leaves a single-line reason unchanged apart from the sentinel prefix", async () => {
    const { formatCycleFailedSentinel } = await import("./failure-category.js");
    expect(formatCycleFailedSentinel("internal", "connection reset")).toBe(
      "CYCLE_FAILED: internal | connection reset",
    );
  });
});
