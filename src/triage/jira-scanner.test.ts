import { describe, expect, it } from "vitest";

// parseTrackerIssue and its helpers are module-private; this test locks in
// the exact Markdown shape ticket-builder.ts produces, since jira-scanner.ts's
// extractors are hand-matched against it (page heading -> immediately
// following table -> first column = selector).
import { markdownToAdf } from "../integrations/tracker/markdown-to-adf.js";
import { adfToMarkdown } from "../integrations/tracker/adf-to-markdown.js";

describe("jira-scanner markdown shape contract", () => {
  it("ticket-builder's page-heading + table shape survives an ADF round trip unchanged", () => {
    const md = [
      "## Affected Elements",
      "### /login",
      "| Selector | HTML | Fix |",
      "| --- | --- | --- |",
      "| button.primary | <button>Go</button> | Add aria-label |",
      "---",
      "## Reference",
      "- Rule: button-name",
    ].join("\n");
    expect(adfToMarkdown(markdownToAdf(md))).toBe(md);
  });
});
