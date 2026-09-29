import { beforeEach, describe, expect, it, vi } from "vitest";

const existsSyncMock = vi.fn().mockReturnValue(true);
vi.mock("node:fs", () => ({ existsSync: (...args: unknown[]) => existsSyncMock(...args) }));

const loggerErrorMock = vi.fn();
vi.mock("./logger.js", () => ({ logger: { error: loggerErrorMock, warn: vi.fn(), info: vi.fn() } }));

describe("validateConfig", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    existsSyncMock.mockReset().mockReturnValue(true);
    loggerErrorMock.mockReset();
    process.env = { ...ORIGINAL_ENV };
    process.env.PROJECT_KEY = "TEST";
    process.env.DATABASE_URL = "postgres://x";
    process.env.TARGET_REPO_PATH = "/repo";
    process.env.JIRA_BASE_URL = "https://x.atlassian.net";
    process.env.JIRA_EMAIL = "a@b.com";
    process.env.JIRA_API_TOKEN = "tok";
    process.env.GITHUB_TOKEN = "gh";
    process.env.GITHUB_OWNER = "acme";
    process.env.GITHUB_REPO = "repo";
  });

  it("passes when every variable required by the given requirements is set", async () => {
    const { validateConfig } = await import("./preflight.js");
    expect(() => validateConfig({ db: true, repo: true, jira: true, github: true })).not.toThrow();
  });

  it("collects every missing variable in one error instead of failing on the first", async () => {
    delete process.env.JIRA_API_TOKEN;
    delete process.env.GITHUB_TOKEN;
    const { validateConfig, ConfigError } = await import("./preflight.js");

    let caught: unknown;
    try {
      validateConfig({ jira: true, github: true });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as InstanceType<typeof ConfigError>).problems).toEqual([
      "JIRA_API_TOKEN is not set.",
      "GITHUB_TOKEN is not set.",
    ]);
  });

  it("does not require jira/github vars when those requirements are not requested", async () => {
    delete process.env.JIRA_API_TOKEN;
    delete process.env.GITHUB_TOKEN;
    const { validateConfig } = await import("./preflight.js");
    expect(() => validateConfig({ db: true, repo: true })).not.toThrow();
  });

  it("flags a TARGET_REPO_PATH that does not exist on disk", async () => {
    existsSyncMock.mockReturnValue(false);
    const { validateConfig, ConfigError } = await import("./preflight.js");
    expect(() => validateConfig({ repo: true })).toThrow(ConfigError);
  });

  it("always requires PROJECT_KEY regardless of requirements", async () => {
    delete process.env.PROJECT_KEY;
    const { validateConfig, ConfigError } = await import("./preflight.js");
    let caught: unknown;
    try {
      validateConfig({});
    } catch (err) {
      caught = err;
    }
    expect((caught as InstanceType<typeof ConfigError>).problems[0]).toContain("PROJECT_KEY");
  });
});
