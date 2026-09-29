import { describe, expect, it, vi, beforeEach } from "vitest";

const readFileMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
}));

describe("readCycleLog", () => {
  beforeEach(() => {
    readFileMock.mockReset();
  });

  it("returns the file contents when the log exists", async () => {
    readFileMock.mockResolvedValueOnce("line one\nline two\n");
    const { readCycleLog } = await import("./log-files");
    expect(await readCycleLog("cycle-1")).toBe("line one\nline two\n");
  });

  it("returns null when the log file does not exist", async () => {
    readFileMock.mockRejectedValueOnce(new Error("ENOENT"));
    const { readCycleLog } = await import("./log-files");
    expect(await readCycleLog("cycle-1")).toBeNull();
  });
});
