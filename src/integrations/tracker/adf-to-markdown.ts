import type { AdfDocument, AdfNode, AdfInline } from "./markdown-to-adf.js";

function inlineToMarkdown(inline: AdfInline): string {
  const hasStrong = inline.marks?.some((m) => m.type === "strong");
  const hasEm = inline.marks?.some((m) => m.type === "em");
  let t = inline.text;
  if (hasStrong) t = `**${t}**`;
  if (hasEm) t = `*${t}*`;
  return t;
}

function inlinesToMarkdown(inlines: AdfInline[] = []): string {
  return inlines.map(inlineToMarkdown).join("");
}

function cellToText(cell: { content: AdfNode[] }): string {
  return cell.content
    .map((n) => (n.type === "paragraph" ? inlinesToMarkdown(n.content) : ""))
    .join(" ")
    .trim();
}

export function adfToMarkdown(doc: AdfDocument | null | undefined): string {
  if (!doc?.content) return "";
  const lines: string[] = [];

  for (const node of doc.content) {
    switch (node.type) {
      case "heading":
        lines.push(`${"#".repeat(node.attrs.level)} ${inlinesToMarkdown(node.content)}`);
        break;
      case "paragraph":
        lines.push(inlinesToMarkdown(node.content));
        break;
      case "rule":
        lines.push("---");
        break;
      case "codeBlock":
        lines.push("```" + (node.attrs.language ?? ""));
        lines.push(inlinesToMarkdown(node.content));
        lines.push("```");
        break;
      case "panel":
        for (const child of node.content) {
          if (child.type === "paragraph") lines.push(`> ${inlinesToMarkdown(child.content)}`);
        }
        break;
      case "bulletList":
        for (const item of node.content) {
          const text = item.content
            .map((n) => (n.type === "paragraph" ? inlinesToMarkdown(n.content) : ""))
            .join(" ");
          lines.push(`- ${text}`);
        }
        break;
      case "table": {
        const [headerRow, ...bodyRows] = node.content;
        if (headerRow) {
          const headerCells = headerRow.content.map(cellToText);
          lines.push(`| ${headerCells.join(" | ")} |`);
          lines.push(`| ${headerCells.map(() => "---").join(" | ")} |`);
          for (const row of bodyRows) {
            lines.push(`| ${row.content.map(cellToText).join(" | ")} |`);
          }
        }
        break;
      }
    }
  }

  return lines.join("\n").trim();
}
