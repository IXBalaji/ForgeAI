import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";

const runMock = vi.fn();

vi.mock("./exec.js", () => ({
  run: runMock,
}));

describe("repo-config", () => {
  const originalTargetRepo = process.env.TARGET_REPO_PATH;

  beforeEach(() => {
    runMock.mockReset();
    if (originalTargetRepo === undefined) delete process.env.TARGET_REPO_PATH; else process.env.TARGET_REPO_PATH = originalTargetRepo;
  });

  it("throws a config error when TARGET_REPO_PATH is missing", async () => {
    delete process.env.TARGET_REPO_PATH;
    const { assertTargetRepoConfigured } = await import("./repo-config.js");

    expect(() => assertTargetRepoConfigured()).toThrow(/TARGET_REPO_PATH is not configured/i);
  });

  it("refreshes qa before creating worktrees", async () => {
    process.env.TARGET_REPO_PATH = "C:/Projects/prospect -01/ForgeAI";
    const { ensureFreshQaBase } = await import("./repo-config.js");
    await ensureFreshQaBase(process.env.TARGET_REPO_PATH);

    expect(runMock).toHaveBeenCalledWith("git", ["fetch", "--all", "--prune"], process.env.TARGET_REPO_PATH);
    expect(runMock).toHaveBeenCalledWith("git", ["fetch", "origin", "qa"], process.env.TARGET_REPO_PATH);
  });
});
