import { describe, expect, it } from "vitest";
import { GitHubAuthError, GitHubApiError } from "./errors.js";

describe("vcs errors", () => {
  it("GitHubAuthError produces an actionable message naming the env var to fix", () => {
    const err = new GitHubAuthError(401, "/user");
    expect(err.message).toContain("invalid or expired");
    expect(err.message).toContain("GITHUB_TOKEN");
  });

  it("GitHubApiError includes the status and response body", () => {
    const err = new GitHubApiError(422, "POST", "/repos/acme/widgets/pulls", "Validation Failed");
    expect(err.message).toContain("422");
    expect(err.message).toContain("Validation Failed");
  });
});
