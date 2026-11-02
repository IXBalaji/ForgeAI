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

describe("assertRepoReadyForCycle", () => {
  beforeEach(() => {
    runMock.mockReset();
    process.env.TARGET_REPO_PATH = "C:/repo";
  });

  it("throws GitNotCleanError when the working tree has uncommitted changes", async () => {
    runMock.mockResolvedValueOnce({ stdout: " M src/foo.ts\n?? bar.txt\n", stderr: "" });
    const { assertRepoReadyForCycle, GitNotCleanError } = await import("./repo-config.js");
    await expect(assertRepoReadyForCycle("C:/repo")).rejects.toThrow(GitNotCleanError);
  });

  it("treats blank/whitespace-only porcelain output as a clean tree", async () => {
    runMock
      .mockResolvedValueOnce({ stdout: "  \n\n", stderr: "" }) // status --porcelain
      .mockResolvedValueOnce({ stdout: "qa", stderr: "" }) // rev-parse --verify (local branch exists)
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // fetch
      .mockResolvedValueOnce({ stdout: "0\t0\n", stderr: "" }); // rev-list ahead/behind
    const { assertRepoReadyForCycle } = await import("./repo-config.js");
    await expect(assertRepoReadyForCycle("C:/repo")).resolves.toBeUndefined();
  });

  it("fast-forwards the checked-out local branch instead of failing when it is behind origin", async () => {
    runMock
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // status --porcelain
      .mockResolvedValueOnce({ stdout: "qa", stderr: "" }) // rev-parse --verify (local branch exists)
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // fetch origin qa
      .mockResolvedValueOnce({ stdout: "0\t2\n", stderr: "" }) // 0 ahead, 2 behind
      .mockResolvedValueOnce({ stdout: "qa\n", stderr: "" }) // rev-parse --abbrev-ref HEAD
      .mockResolvedValueOnce({ stdout: "", stderr: "" }); // merge --ff-only
    const { assertRepoReadyForCycle } = await import("./repo-config.js");
    await expect(assertRepoReadyForCycle("C:/repo")).resolves.toBeUndefined();
    expect(runMock).toHaveBeenCalledWith("git", ["merge", "--ff-only", "origin/qa"], "C:/repo");
  });

  it("updates the local branch ref directly when behind and not currently checked out", async () => {
    runMock
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // status --porcelain
      .mockResolvedValueOnce({ stdout: "qa", stderr: "" }) // rev-parse --verify (local branch exists)
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // fetch origin qa
      .mockResolvedValueOnce({ stdout: "0\t2\n", stderr: "" }) // 0 ahead, 2 behind
      .mockResolvedValueOnce({ stdout: "main\n", stderr: "" }) // rev-parse --abbrev-ref HEAD (on a different branch)
      .mockResolvedValueOnce({ stdout: "", stderr: "" }); // fetch origin qa:qa
    const { assertRepoReadyForCycle } = await import("./repo-config.js");
    await expect(assertRepoReadyForCycle("C:/repo")).resolves.toBeUndefined();
    expect(runMock).toHaveBeenCalledWith("git", ["fetch", "origin", "qa:qa"], "C:/repo");
  });

  it("throws GitNotSyncedError when the local branch exists and has unpushed commits ahead of origin", async () => {
    runMock
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "qa", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "3\t0\n", stderr: "" }); // 3 ahead, 0 behind
    const { assertRepoReadyForCycle, GitNotSyncedError } = await import("./repo-config.js");
    await expect(assertRepoReadyForCycle("C:/repo")).rejects.toThrow(GitNotSyncedError);
  });

  it("fetches origin before comparing ahead/behind counts, when a local branch exists", async () => {
    runMock
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "qa", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "0\t0\n", stderr: "" });
    const { assertRepoReadyForCycle } = await import("./repo-config.js");
    await assertRepoReadyForCycle("C:/repo");
    expect(runMock).toHaveBeenCalledWith("git", ["fetch", "origin", "qa"], "C:/repo");
  });

  it("skips the ahead/behind check entirely when there is no local branch ref to compare", async () => {
    // This pipeline creates worktrees straight from origin/<branch> and never
    // checks it out in TARGET_REPO_PATH itself — a missing local ref is the
    // common case, not an error condition.
    runMock
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // status --porcelain
      .mockRejectedValueOnce(new Error("fatal: Needed a single revision")); // rev-parse --verify fails
    const { assertRepoReadyForCycle } = await import("./repo-config.js");
    await expect(assertRepoReadyForCycle("C:/repo")).resolves.toBeUndefined();
    expect(runMock).toHaveBeenCalledTimes(2);
    expect(runMock).not.toHaveBeenCalledWith("git", ["fetch", "origin", "qa"], "C:/repo");
  });
});
