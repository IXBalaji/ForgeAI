import { describe, expect, it } from "vitest";
import { JiraAuthError, JiraApiError } from "./errors.js";

describe("tracker errors", () => {
  it("JiraAuthError produces an actionable message naming the env var to fix", () => {
    const err = new JiraAuthError(401, "/rest/api/3/issue/PROJ-1");
    expect(err.message).toContain("invalid or expired");
    expect(err.message).toContain("JIRA_API_TOKEN");
  });

  it("JiraApiError includes the status and response body", () => {
    const err = new JiraApiError(400, "POST", "/rest/api/3/issue", "Bad request body");
    expect(err.message).toContain("400");
    expect(err.message).toContain("Bad request body");
  });
});
