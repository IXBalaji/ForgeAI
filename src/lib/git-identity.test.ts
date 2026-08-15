import { beforeEach, describe, expect, it, vi } from "vitest";

const runMock = vi.fn();

vi.mock("./exec.js", () => ({
  run: runMock,
}));

const originalAuthorName = process.env.GIT_AUTHOR_NAME;
const originalAuthorEmail = process.env.GIT_AUTHOR_EMAIL;

describe("ensureGitIdentity", () => {
  beforeEach(() => {
    runMock.mockReset();
    if (originalAuthorName === undefined) delete process.env.GIT_AUTHOR_NAME; else process.env.GIT_AUTHOR_NAME = originalAuthorName;
    if (originalAuthorEmail === undefined) delete process.env.GIT_AUTHOR_EMAIL; else process.env.GIT_AUTHOR_EMAIL = originalAuthorEmail;
  });

  it("writes the local git identity before a commit", async () => {
    process.env.GIT_AUTHOR_NAME = "ForgeAI Bot";
    process.env.GIT_AUTHOR_EMAIL = "forgeai-bot@example.com";

    const { ensureGitIdentity } = await import("./git-identity.js");
    await ensureGitIdentity("/tmp/repo");

    expect(runMock).toHaveBeenCalledWith("git", ["config", "user.name", "ForgeAI Bot"], "/tmp/repo");
    expect(runMock).toHaveBeenCalledWith("git", ["config", "user.email", "forgeai-bot@example.com"], "/tmp/repo");
  });
});
