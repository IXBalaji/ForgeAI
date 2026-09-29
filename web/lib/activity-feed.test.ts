import { describe, it, expect } from "vitest";
import { filterActivityLines } from "./activity-feed";

describe("filterActivityLines", () => {
  it("keeps only tagged pipeline lines, dropping blank lines and raw dumps", () => {
    const lines = [
      "[orchestrate] Starting pipeline — cycle abc",
      "{",
      "  resource: {",
      "    attributes: {",
      "  }",
      "}",
      "",
      "[triage] Found 26 page reports",
    ];
    expect(filterActivityLines(lines, 10)).toEqual([
      "[orchestrate] Starting pipeline — cycle abc",
      "[triage] Found 26 page reports",
    ]);
  });

  it("drops lines from excluded tags", () => {
    const lines = [
      "[observability] LangSmith tracing on — project \"AI-POC\".",
      "[email] SMTP configured: host=smtp.gmail.com",
      "[triage] Classifying issues with LLM...",
    ];
    expect(filterActivityLines(lines, 10)).toEqual(["[triage] Classifying issues with LLM..."]);
  });

  it("keeps only the most recent `limit` lines", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `[triage] step ${i}`);
    expect(filterActivityLines(lines, 2)).toEqual(["[triage] step 3", "[triage] step 4"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterActivityLines(["no tag here", "  "], 10)).toEqual([]);
  });
});
