import { describe, expect, it } from "vitest";
import { markdownToAdf } from "./markdown-to-adf.js";
import { adfToMarkdown } from "./adf-to-markdown.js";

describe("Markdown <-> ADF round trip", () => {
  it("preserves headings, bold/em text, and paragraphs", () => {
    const md = [
      "## Summary",
      "This is **bold** and this is *emphasis*.",
      "### Sub Heading",
      "Plain paragraph.",
    ].join("\n");
    const roundTripped = adfToMarkdown(markdownToAdf(md));
    expect(roundTripped).toBe(md);
  });

  it("preserves bullet lists", () => {
    const md = ["## Affected Pages", "- /login", "- /checkout", "- /settings"].join("\n");
    expect(adfToMarkdown(markdownToAdf(md))).toBe(md);
  });

  it("preserves fenced code blocks with a language tag", () => {
    const md = ["## Affected Elements", "```css", "button.primary\ninput[type=text]", "```"].join("\n");
    expect(adfToMarkdown(markdownToAdf(md))).toBe(md);
  });

  it("preserves pipe tables with a header row", () => {
    const md = [
      "## Details",
      "| Selector | Fix |",
      "| --- | --- |",
      "| button.primary | Add aria-label |",
      "| input[type=text] | Add label element |",
    ].join("\n");
    expect(adfToMarkdown(markdownToAdf(md))).toBe(md);
  });

  it("preserves a horizontal rule and a blockquote panel", () => {
    const md = ["> Priority: **P1** | Impact: critical", "---", "Reference notes here."].join("\n");
    expect(adfToMarkdown(markdownToAdf(md))).toBe(md);
  });

  it("round-trips a full ticket-shaped document", () => {
    const md = [
      "> Issue Type: **Code Change Required** | Priority: **P1** | Impact: **critical**",
      "## Summary",
      "Images are missing alt text.",
      "## Scope",
      "**12** affected element(s) across **3** page(s)",
      "- /login",
      "- /checkout",
      "## Affected Elements",
      "### /login",
      "| Selector | HTML | Fix |",
      "| --- | --- | --- |",
      "| img.logo | <img src=\"/logo.png\"> | Add alt attribute |",
      "---",
      "## Reference",
      "- Rule: image-alt",
      "- Docs: https://dequeuniversity.com/rules/axe/4.7/image-alt",
    ].join("\n");
    expect(adfToMarkdown(markdownToAdf(md))).toBe(md);
  });
});
