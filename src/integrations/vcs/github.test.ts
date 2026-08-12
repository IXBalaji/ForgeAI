import { describe, expect, it, afterEach, vi } from "vitest";

// This repo's .env has real GITHUB_TOKEN/OWNER/REPO — without this mock,
// "import dotenv/config" inside github.ts would re-populate whatever we
// delete from process.env on every fresh module import below.
vi.mock("dotenv/config", () => ({}));

const ORIGINAL_ENV = { ...process.env };

describe("GitHubAdapter", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("authenticatedRemoteUrl returns null when unconfigured", async () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_OWNER;
    delete process.env.GITHUB_REPO;
    // @ts-expect-error cache-busting query string forces a fresh module instance; not a real resolvable path for tsc
    const { GitHubAdapter } = await import("./github.js?unconfigured1");
    const adapter = new GitHubAdapter();
    expect(adapter.isConfigured()).toBe(false);
    expect(adapter.authenticatedRemoteUrl()).toBeNull();
  });

  it("authenticatedRemoteUrl builds the x-access-token URL when configured", async () => {
    process.env.GITHUB_TOKEN = "tok123";
    process.env.GITHUB_OWNER = "acme";
    process.env.GITHUB_REPO = "widgets";
    // @ts-expect-error cache-busting query string forces a fresh module instance; not a real resolvable path for tsc
    const { GitHubAdapter } = await import("./github.js?configured1");
    const adapter = new GitHubAdapter();
    expect(adapter.isConfigured()).toBe(true);
    expect(adapter.authenticatedRemoteUrl()).toBe(
      "https://x-access-token:tok123@github.com/acme/widgets.git",
    );
  });

  it("isConflictError matches GitHub's merge-conflict response text", async () => {
    // @ts-expect-error cache-busting query string forces a fresh module instance; not a real resolvable path for tsc
    const { GitHubAdapter } = await import("./github.js?conflict1");
    const adapter = new GitHubAdapter();
    expect(adapter.isConflictError(new Error("GitHub API POST /repos/a/b/merges failed: 409 conflict"))).toBe(true);
    expect(adapter.isConflictError(new Error("GitHub API POST /repos/a/b/merges failed: 405 Merge conflict"))).toBe(true);
    expect(adapter.isConflictError(new Error("GitHub API GET /repos/a/b/pulls failed: 401 Bad credentials"))).toBe(false);
  });
});
