export type AdfMark = { type: "strong" } | { type: "em" };
export type AdfInline = { type: "text"; text: string; marks?: AdfMark[] };

export type AdfNode =
  | { type: "heading"; attrs: { level: number }; content: AdfInline[] }
  | { type: "paragraph"; content: AdfInline[] }
  | { type: "bulletList"; content: Array<{ type: "listItem"; content: AdfNode[] }> }
  | { type: "codeBlock"; attrs: { language?: string }; content: AdfInline[] }
  | {
      type: "table";
      content: Array<{ type: "tableRow"; content: Array<{ type: "tableHeader" | "tableCell"; content: AdfNode[] }> }>;
    }
  | { type: "rule" }
  | { type: "panel"; attrs: { panelType: string }; content: AdfNode[] };

export interface AdfDocument {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

function parseInline(text: string): AdfInline[] {
  const inlines: AdfInline[] = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) inlines.push({ type: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined) inlines.push({ type: "text", text: m[1], marks: [{ type: "strong" }] });
    else if (m[2] !== undefined) inlines.push({ type: "text", text: m[2], marks: [{ type: "em" }] });
    last = re.lastIndex;
  }
  if (last < text.length) inlines.push({ type: "text", text: text.slice(last) });
  if (inlines.length === 0) inlines.push({ type: "text", text: "" });
  return inlines;
}

function parseTableRow(line: string): string[] {
  return line.split("|").slice(1, -1).map((cell) => cell.trim());
}

export function markdownToAdf(markdown: string): AdfDocument {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const content: AdfNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    const headingMatch = line.match(/^(#{2,3})\s+(.*)$/);
    if (headingMatch) {
      content.push({ type: "heading", attrs: { level: headingMatch[1].length }, content: parseInline(headingMatch[2]) });
      i++;
      continue;
    }

    if (line.trim() === "---") {
      content.push({ type: "rule" });
      i++;
      continue;
    }

    if (line.startsWith("```")) {
      const language = line.slice(3).trim() || undefined;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      content.push({ type: "codeBlock", attrs: { language }, content: [{ type: "text", text: codeLines.join("\n") }] });
      continue;
    }

    if (line.startsWith("> ") || line === ">") {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i].startsWith("> ") || lines[i] === ">")) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      content.push({
        type: "panel",
        attrs: { panelType: "info" },
        content: quoteLines
          .filter((l) => l.trim() !== "")
          .map((l) => ({ type: "paragraph" as const, content: parseInline(l) })),
      });
      continue;
    }

    if (line.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith("- ")) {
        items.push(lines[i].slice(2));
        i++;
      }
      content.push({
        type: "bulletList",
        content: items.map((item) => ({
          type: "listItem" as const,
          content: [{ type: "paragraph" as const, content: parseInline(item) }],
        })),
      });
      continue;
    }

    if (line.startsWith("|") && line.trim().endsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      const dataLines = tableLines.filter((l) => !/^\|[\s:|-]+\|$/.test(l));
      const tableContent = dataLines.map((l, rowIdx) => ({
        type: "tableRow" as const,
        content: parseTableRow(l).map((cell) => ({
          type: (rowIdx === 0 ? "tableHeader" : "tableCell") as "tableHeader" | "tableCell",
          content: [{ type: "paragraph" as const, content: parseInline(cell) }],
        })),
      }));
      content.push({ type: "table", content: tableContent });
      continue;
    }

    content.push({ type: "paragraph", content: parseInline(line) });
    i++;
  }

  return { type: "doc", version: 1, content };
}
