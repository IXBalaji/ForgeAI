import { describe, it, expect } from "vitest";
import { buildScanResults, buildTicketRows, type AxeReport } from "./run-results";

const START = new Date("2026-09-29T10:00:00Z");
const END = new Date("2026-09-29T10:30:00Z");

function report(url: string, timestamp: string, violations: AxeReport["violations"]): AxeReport {
  return { url, timestamp, violations };
}

const contrast = (targets: string[]) => ({
  id: "color-contrast",
  impact: "serious",
  help: "Elements must meet minimum color contrast ratio thresholds",
  helpUrl: "https://dequeuniversity.com/rules/axe/4.12/color-contrast",
  tags: ["cat.color", "wcag2aa", "wcag143"],
  nodes: targets.map((t) => ({ target: [t], html: `<p class="${t}">x</p>`, failureSummary: "Fix contrast" })),
});

const buttonName = {
  id: "button-name",
  impact: "critical",
  help: "Buttons must have discernible text",
  helpUrl: "https://dequeuniversity.com/rules/axe/4.12/button-name",
  tags: ["wcag2a", "wcag412"],
  nodes: [{ target: ["tr > button"], html: "<button></button>", failureSummary: null }],
};

describe("buildScanResults", () => {
  it("aggregates violations by rule across page states, sorted by severity", () => {
    const result = buildScanResults(
      [
        { state: "admin-leave-policies", report: report("https://qa/admin/leave-policies", "2026-09-29T10:05:00Z", [contrast([".a", ".b"])]) },
        { state: "employee-leave-apply", report: report("https://qa/leave/apply", "2026-09-29T10:06:00Z", [contrast([".c"])]) },
        { state: "employee-leave-apply-errors", report: report("https://qa/leave/apply", "2026-09-29T10:07:00Z", []) },
        { state: "manager-approvals", report: report("https://qa/leave/approvals", "2026-09-29T10:08:00Z", [buttonName]) },
      ],
      { startedAt: START, endedAt: END },
    );

    expect(result.available).toBe(true);
    expect(result.statesScanned).toBe(4);
    expect(result.pagesScanned).toBe(3);
    expect(result.elementCount).toBe(4);
    expect(result.bySeverity).toEqual({ critical: 1, serious: 1, moderate: 0, minor: 0 });
    expect(result.groups.map((g) => g.ruleId)).toEqual(["button-name", "color-contrast"]);

    const cc = result.groups[1];
    expect(cc.wcag).toEqual(["1.4.3"]);
    expect(cc.elementCount).toBe(3);
    expect(cc.pageCount).toBe(2);
    expect(cc.pages[0]).toMatchObject({ url: "https://qa/admin/leave-policies", state: "admin-leave-policies" });
    expect(cc.pages[0].nodes[0]).toEqual({ selector: ".a", html: '<p class=".a">x</p>', failureSummary: "Fix contrast" });
  });

  it("ignores reports outside the run's time window", () => {
    const result = buildScanResults(
      [
        { state: "stale", report: report("https://qa/old", "2026-09-28T09:00:00Z", [buttonName]) },
        { state: "later-run", report: report("https://qa/new", "2026-09-29T11:00:00Z", [buttonName]) },
        { state: "this-run", report: report("https://qa/x", "2026-09-29T10:10:00Z", []) },
      ],
      { startedAt: START, endedAt: END },
    );
    expect(result.statesScanned).toBe(1);
    expect(result.groups).toEqual([]);
  });

  it("has no upper bound while the run has no end time", () => {
    const result = buildScanResults(
      [{ state: "s", report: report("https://qa/x", "2026-09-30T00:00:00Z", [buttonName]) }],
      { startedAt: START, endedAt: null },
    );
    expect(result.groups).toHaveLength(1);
  });

  it("reports unavailable when no report is from this run", () => {
    const result = buildScanResults([], { startedAt: START, endedAt: END });
    expect(result.available).toBe(false);
  });

  it("truncates long HTML snippets and tolerates unknown impacts", () => {
    const long = { ...buttonName, impact: null, nodes: [{ target: ["b"], html: "x".repeat(1000), failureSummary: null }] };
    const result = buildScanResults(
      [{ state: "s", report: report("https://qa/x", "2026-09-29T10:10:00Z", [long]) }],
      { startedAt: START, endedAt: END },
    );
    expect(result.groups[0].severity).toBe("minor");
    expect(result.groups[0].pages[0].nodes[0].html.length).toBeLessThanOrEqual(401);
  });
});

describe("buildTicketRows", () => {
  const issues = [
    { id: "i1", severity: "serious", pageUrl: "https://qa/a" },
    { id: "i2", severity: "critical", pageUrl: "https://qa/a" },
    { id: "i3", severity: "moderate", pageUrl: "https://qa/b" },
  ];

  it("derives severity, counts, new/updated and fix details per ticket", () => {
    const rows = buildTicketRows({
      tickets: [
        { id: "t1", jiraKey: "A11Y-1", category: "Color contrast", status: "done", issueIds: ["i1", "i2", "i3"], createdAt: new Date("2026-09-29T10:02:00Z") },
        { id: "t2", jiraKey: null, category: "Labels", status: "open", issueIds: [], createdAt: new Date("2026-09-20T10:00:00Z") },
      ],
      issues,
      attempts: [
        { id: "a1", ticketId: "t1", prUrl: null, createdAt: new Date("2026-09-29T10:10:00Z") },
        { id: "a2", ticketId: "t1", prUrl: "https://gh/pr/7", createdAt: new Date("2026-09-29T10:20:00Z") },
      ],
      reviews: [
        { fixAttemptId: "a1", verdict: "rejected", createdAt: new Date("2026-09-29T10:12:00Z") },
        { fixAttemptId: "a2", verdict: "approved", createdAt: new Date("2026-09-29T10:22:00Z") },
      ],
      startedAt: START,
      jiraBaseUrl: "https://acme.atlassian.net/",
    });

    expect(rows[0]).toEqual({
      id: "t1",
      jiraKey: "A11Y-1",
      jiraUrl: "https://acme.atlassian.net/browse/A11Y-1",
      category: "Color contrast",
      status: "done",
      isNew: true,
      severity: "critical",
      issueCount: 3,
      pageCount: 2,
      attempts: 2,
      reviewVerdict: "approved",
      prUrl: "https://gh/pr/7",
    });
    expect(rows[1]).toMatchObject({ isNew: false, severity: null, issueCount: 0, jiraUrl: null, attempts: 0, reviewVerdict: null, prUrl: null });
  });

  it("sorts by severity, then Jira key", () => {
    const rows = buildTicketRows({
      tickets: [
        { id: "t1", jiraKey: "A-2", category: "x", status: "open", issueIds: ["i3"], createdAt: START },
        { id: "t2", jiraKey: "A-1", category: "y", status: "open", issueIds: ["i2"], createdAt: START },
        { id: "t3", jiraKey: "A-3", category: "z", status: "open", issueIds: ["i3"], createdAt: START },
      ],
      issues,
      attempts: [],
      reviews: [],
      startedAt: START,
      jiraBaseUrl: undefined,
    });
    expect(rows.map((r) => r.jiraKey)).toEqual(["A-1", "A-2", "A-3"]);
  });
});
