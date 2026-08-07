import { chromium } from "playwright";
import type { RawFinding } from "./axe-scan.js";
import type { Severity } from "../types/index.js";

const VISION_MODEL = process.env.CLAUDE_VISION_MODEL ?? "claude-opus-5";

const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          issue: { type: "string", description: "Short label for the issue, e.g. 'low-contrast-text-over-image'" },
          location: { type: "string", description: "Where on the page this is, described precisely enough for a developer to find it" },
          severity: { type: "string", enum: ["critical", "serious", "moderate", "minor"] },
        },
        required: ["issue", "location", "severity"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
} as const;

/**
 * Claude vision pass — for what static rule engines structurally can't catch:
 * contrast of text baked into images, illogical visual reading order, focus
 * indicators that are technically present in the DOM but not visually
 * distinguishable. Screenshots only; no DOM access, so "selector" here is a
 * plain-language location, not a CSS selector.
 */
export async function runVisionScan(baseUrl: string, routes: string[]): Promise<RawFinding[]> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("[vision-scan] ANTHROPIC_API_KEY not set — skipping the vision pass.");
    return [];
  }

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();

  const findings: RawFinding[] = [];
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    for (const route of routes) {
      const pageUrl = new URL(route, baseUrl).toString();
      await page.goto(pageUrl, { waitUntil: "networkidle" });
      const screenshot = await page.screenshot({ fullPage: true });

      const response = await client.messages.create({
        model: VISION_MODEL,
        max_tokens: 2048,
        output_config: { format: { type: "json_schema", schema: FINDINGS_SCHEMA } },
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: screenshot.toString("base64") } },
              {
                type: "text",
                text: [
                  "Look for accessibility problems a static rule engine like axe-core cannot detect from the DOM alone:",
                  "text with insufficient contrast baked into an image, a visual reading order that doesn't match a logical",
                  "top-to-bottom/left-to-right flow, or focus/interactive elements with no visible focus indicator style.",
                  "Only report issues you can actually see in this screenshot. If there are none, return an empty findings array.",
                ].join(" "),
              },
            ],
          },
        ],
      });

      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") continue;
      const parsed = JSON.parse(textBlock.text) as { findings: Array<{ issue: string; location: string; severity: Severity }> };

      for (const f of parsed.findings) {
        findings.push({
          source: "vision",
          wcagRule: f.issue,
          selector: f.location,
          pageUrl,
          severity: f.severity,
        });
      }
    }
  } catch (err) {
    console.warn("[vision-scan] Vision pass failed — continuing without it.", err);
  } finally {
    await browser.close();
  }
  return findings;
}
