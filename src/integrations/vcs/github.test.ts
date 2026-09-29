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

  describe("PR lifecycle", () => {
    function jsonResponse(body: unknown, status = 200) {
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    }

    function setConfiguredEnv() {
      process.env.GITHUB_TOKEN = "tok123";
      process.env.GITHUB_OWNER = "acme";
      process.env.GITHUB_REPO = "widgets";
    }

    it("findOpenPullRequest returns null when unconfigured", async () => {
      delete process.env.GITHUB_TOKEN;
      // @ts-expect-error cache-busting
      const { GitHubAdapter } = await import("./github.js?pr-unconfigured");
      const adapter = new GitHubAdapter();
      expect(await adapter.findOpenPullRequest("head", "qa")).toBeNull();
    });

    it("findOpenPullRequest returns the first match or null", async () => {
      setConfiguredEnv();
      // @ts-expect-error cache-busting
      const { GitHubAdapter } = await import("./github.js?pr-find1");
      const adapter = new GitHubAdapter();
      const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
        jsonResponse([{ number: 42, url: "u", html_url: "h", head: { sha: "abc" } }]),
      );
      const ref = await adapter.findOpenPullRequest("fix/branch", "qa");
      expect(ref).toEqual({ number: 42, url: "u", htmlUrl: "h", headSha: "abc" });
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/pulls?head=acme%3Afix%2Fbranch&base=qa&state=open"),
        expect.any(Object),
      );
      fetchSpy.mockRestore();
    });

    it("createPullRequest posts to the pulls endpoint", async () => {
      setConfiguredEnv();
      // @ts-expect-error cache-busting
      const { GitHubAdapter } = await import("./github.js?pr-create1");
      const adapter = new GitHubAdapter();
      const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
        jsonResponse({ number: 7, url: "u", html_url: "h", head: { sha: "def" } }),
      );
      const ref = await adapter.createPullRequest("fix/branch", "qa", "Title", "Body");
      expect(ref).toEqual({ number: 7, url: "u", htmlUrl: "h", headSha: "def" });
      const [, init] = fetchSpy.mock.calls[0];
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ title: "Title", head: "fix/branch", base: "qa", body: "Body" });
      fetchSpy.mockRestore();
    });

    it("getPullRequestStatus polls when mergeable is still null", async () => {
      setConfiguredEnv();
      // @ts-expect-error cache-busting
      const { GitHubAdapter } = await import("./github.js?pr-status1");
      const adapter = new GitHubAdapter();
      const fetchSpy = vi
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(jsonResponse({ number: 1, merged: false, mergeable: null, mergeable_state: "unknown", head: { sha: "s1" }, user: { login: "bot" } }))
        .mockResolvedValueOnce(jsonResponse({ number: 1, merged: false, mergeable: true, mergeable_state: "clean", head: { sha: "s1" }, user: { login: "bot" } }))
        .mockResolvedValueOnce(jsonResponse([{ state: "APPROVED", user: { login: "other-bot" } }]))
        .mockResolvedValueOnce(jsonResponse({ login: "bot" }));

      const status = await adapter.getPullRequestStatus(1);
      expect(status?.mergeable).toBe(true);
      expect(status?.reviewState).toBe("APPROVED");
      expect(status?.selfAuthored).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(4);
      fetchSpy.mockRestore();
    }, 10000);

    it("approvePullRequest returns null instead of throwing when GitHub rejects self-approval", async () => {
      setConfiguredEnv();
      // @ts-expect-error cache-busting
      const { GitHubAdapter } = await import("./github.js?pr-approve-self");
      const adapter = new GitHubAdapter();
      const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: async () => ({}),
        text: async () => JSON.stringify({ message: "Unprocessable Entity", errors: ["Review Can not approve your own pull request"] }),
      } as Response);

      const result = await adapter.approvePullRequest(9, "Approving");
      expect(result).toBeNull();
      fetchSpy.mockRestore();
    });

    it("mergePullRequest PUTs to the merge endpoint", async () => {
      setConfiguredEnv();
      // @ts-expect-error cache-busting
      const { GitHubAdapter } = await import("./github.js?pr-merge1");
      const adapter = new GitHubAdapter();
      const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({ sha: "merged123" }));
      const sha = await adapter.mergePullRequest(5, "merge");
      expect(sha).toBe("merged123");
      const [, init] = fetchSpy.mock.calls[0];
      expect(init?.method).toBe("PUT");
      fetchSpy.mockRestore();
    });

    it("addReviewComments falls back to an issue comment when a file has no diff patch", async () => {
      setConfiguredEnv();
      // @ts-expect-error cache-busting
      const { GitHubAdapter } = await import("./github.js?pr-comments1");
      const adapter = new GitHubAdapter();
      const fetchSpy = vi
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(jsonResponse([{ filename: "src/a.ts", patch: "@@ -1 +1 @@" }])) // pulls/files
        .mockResolvedValueOnce(jsonResponse({ id: 999 })); // fallback issue comment

      const reviewId = await adapter.addReviewComments(3, [
        { path: "src/missing.ts", line: 10, side: "RIGHT", body: "not in diff" },
      ]);
      expect(reviewId).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[1][0]).toContain("/issues/3/comments");
      fetchSpy.mockRestore();
    });
  });
});

describe("GitHubAdapter — typed error classification", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("throws GitHubAuthError (not GitHubApiError) on a 401 response", async () => {
    process.env.GITHUB_TOKEN = "tok";
    process.env.GITHUB_OWNER = "acme";
    process.env.GITHUB_REPO = "widgets";
    // @ts-expect-error cache-busting query string forces a fresh module instance; not a real resolvable path for tsc
    const { GitHubAdapter } = await import("./github.js?autherr1");
    const { GitHubAuthError } = await import("./errors.js");
    const adapter = new GitHubAdapter();

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Bad credentials",
    } as Response);

    await expect(adapter.createTag("v1", "sha1")).rejects.toThrow(GitHubAuthError);
  });

  it("throws GitHubApiError (not GitHubAuthError) on a 422 response", async () => {
    process.env.GITHUB_TOKEN = "tok";
    process.env.GITHUB_OWNER = "acme";
    process.env.GITHUB_REPO = "widgets";
    // @ts-expect-error cache-busting query string forces a fresh module instance; not a real resolvable path for tsc
    const { GitHubAdapter } = await import("./github.js?apierr1");
    const { GitHubApiError, GitHubAuthError } = await import("./errors.js");
    const adapter = new GitHubAdapter();

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: async () => "Validation Failed",
    } as Response);

    let caught: unknown;
    try {
      await adapter.createTag("v1", "sha1");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitHubApiError);
    expect(caught).not.toBeInstanceOf(GitHubAuthError);
  });
});
