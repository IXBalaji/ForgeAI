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

describe("createReleasePr", () => {
  it("wraps a createPullRequest rejection in a ReleaseError with a clear message", async () => {
    const { createReleasePr, ReleaseError } = await import("./release-agent.js");
    const vcs = { createPullRequest: vi.fn().mockRejectedValue(new Error("422 Validation Failed")) } as any;

    await expect(createReleasePr(vcs, "qa", "main", "title", "body")).rejects.toThrow(ReleaseError);
    await expect(createReleasePr(vcs, "qa", "main", "title", "body")).rejects.toThrow(/Pull request could not be created/);
  });

  it("returns the PR ref on success", async () => {
    const { createReleasePr } = await import("./release-agent.js");
    const vcs = { createPullRequest: vi.fn().mockResolvedValue({ number: 5, htmlUrl: "https://x/5" }) } as any;
    const result = await createReleasePr(vcs, "qa", "main", "title", "body");
    expect(result).toEqual({ number: 5, htmlUrl: "https://x/5" });
  });
});
