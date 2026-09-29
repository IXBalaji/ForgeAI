import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const appendFileSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const existsSyncMock = vi.fn().mockReturnValue(true);

vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
  appendFileSync: (...args: unknown[]) => appendFileSyncMock(...args),
}));

describe("logger", () => {
  beforeEach(() => {
    appendFileSyncMock.mockReset();
    mkdirSyncMock.mockReset();
    existsSyncMock.mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes to the startup log when no cycle context is active", async () => {
    const { logger } = await import("./logger.js");
    logger.info("preflight", "checking config");

    expect(appendFileSyncMock).toHaveBeenCalledTimes(1);
    const [filePath, content] = appendFileSyncMock.mock.calls[0];
    expect(filePath).toMatch(/logger[\\/]startup-.*\.log$/);
    expect(content).toContain("[INFO] [preflight] checking config");
  });

  it("writes to logger/{cycleId}/cycle.log inside a cycle context", async () => {
    const { logger, runWithCycleLogger } = await import("./logger.js");
    await runWithCycleLogger("cycle-123", async () => {
      logger.warn("orchestrator", "something odd happened");
    });

    const [filePath, content] = appendFileSyncMock.mock.calls[0];
    expect(filePath).toMatch(/logger[\\/]cycle-123[\\/]cycle\.log$/);
    expect(content).toContain("[WARN] [orchestrator] something odd happened");
  });

  it("includes the error stack in the file when an Error is passed", async () => {
    const { logger, runWithCycleLogger } = await import("./logger.js");
    await runWithCycleLogger("cycle-err", async () => {
      logger.error("release", "PR creation failed", new Error("boom"));
    });

    const [, content] = appendFileSyncMock.mock.calls[0];
    expect(content).toContain("[ERROR] [release] PR creation failed");
    expect(content).toContain("boom");
  });

  it("still echoes to console with today's [module] message shape", async () => {
    const { logger } = await import("./logger.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.info("triage", "classified 4 issues");
    expect(logSpy).toHaveBeenCalledWith("[triage] classified 4 issues");
  });
});
