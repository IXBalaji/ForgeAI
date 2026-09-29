import { describe, expect, it } from "vitest";
import { parseFailureFromLog, isCycleFailed } from "./run-status";

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

describe("isCycleFailed", () => {
  it("is true when a failure category was parsed from the log, even with exitCode 0", () => {
    // The web app's status route cannot capture the orchestrator child process's
    // real exit code (see status/route.ts's comment) — it hardcodes exitCode to 0
    // whenever the process is no longer alive. Without the sentinel-derived
    // category, a crashed-but-closed cycle would render as "Complete".
    expect(isCycleFailed(0, "config")).toBe(true);
  });

  it("is true when the exit code is a nonzero number, even with no failure category", () => {
    expect(isCycleFailed(1, null)).toBe(true);
  });

  it("is false when there is no failure category and the exit code is 0 or null", () => {
    expect(isCycleFailed(0, null)).toBe(false);
    expect(isCycleFailed(null, null)).toBe(false);
  });
});
