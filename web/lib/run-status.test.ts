import { describe, expect, it } from "vitest";
import { parseFailureFromLog } from "./run-status";

describe("parseFailureFromLog", () => {
  it("extracts category and reason from the CYCLE_FAILED sentinel line", () => {
    const lines = [
      "[orchestrate] Starting pipeline",
      "CYCLE_FAILED: jira-auth | Jira API token is invalid or expired (HTTP 401 on /rest/api/3/issue/PROJ-1). Update JIRA_API_TOKEN and retry.",
    ];
    expect(parseFailureFromLog(lines)).toEqual({
      failureCategory: "jira-auth",
      failureReason: "Jira API token is invalid or expired (HTTP 401 on /rest/api/3/issue/PROJ-1). Update JIRA_API_TOKEN and retry.",
    });
  });

  it("returns nulls when no sentinel line is present", () => {
    expect(parseFailureFromLog(["[orchestrate] Starting pipeline"])).toEqual({
      failureCategory: null,
      failureReason: null,
    });
  });

  it("picks the last sentinel line, ignoring an earlier decoy containing similar text", () => {
    const lines = [
      'CYCLE_FAILED: release | earlier text that a retried step logged: "CYCLE_FAILED: internal | stale decoy"',
      "CYCLE_FAILED: config | PROJECT_KEY is not set.",
    ];
    expect(parseFailureFromLog(lines)).toEqual({
      failureCategory: "config",
      failureReason: "PROJECT_KEY is not set.",
    });
  });
});
