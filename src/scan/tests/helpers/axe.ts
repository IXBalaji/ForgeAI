import { Page, TestInfo } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import fs from "fs";
import path from "path";
import { resolveAxeConfig } from "../../scan-config.js";

export const REPORT_DIR = path.join(process.cwd(), "a11y-reports");

export function ensureReportDir() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}

const _resolved = resolveAxeConfig();
export const AXE_TAGS: string[] = _resolved.tags;

export async function runAxeScan(
  page: Page,
  testInfo: TestInfo,
  options: { label: string; fileSlug: string; tags?: string[]; rules?: string[] },
) {
  if (options.tags && options.rules) {
    throw new Error(`runAxeScan("${options.fileSlug}"): pass tags OR rules, not both`);
  }
  ensureReportDir();

  let builder = new AxeBuilder({ page });
  if (options.tags) builder = builder.withTags(options.tags);
  if (options.rules) builder = builder.withRules(options.rules);

  if (_resolved.enabledRules.length > 0) {
    builder = builder.withRules(_resolved.enabledRules);
  }
  if (_resolved.disabledRules.length > 0) {
    builder = builder.disableRules(_resolved.disabledRules);
  }

  const results = await builder.analyze();

  const jsonPath = path.join(REPORT_DIR, `${options.fileSlug}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  await testInfo.attach(`axe-results-${options.fileSlug}.json`, {
    path: jsonPath,
    contentType: "application/json",
  });

  const summary = results.violations
    .map((v) => `${v.impact ?? "n/a"} | ${v.id} | ${v.nodes.length} node(s) | ${v.help}`)
    .join("\n");
  console.log(
    `\n${options.label} found ${results.violations.length} violation type(s):\n${summary || "(none)"}\n`,
  );

  return results;
}
