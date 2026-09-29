import { traceAnthropicAgentSdkQuery } from "../observability/anthropic-tracing.js";
import { run } from "../lib/exec.js";
import { REVIEWER_MODEL, REVIEWER_EFFORT } from "../lib/config.js";
import { logger } from "../lib/logger.js";

const QA_BRANCH = `origin/${process.env.GITHUB_QA_BRANCH ?? "qa"}`;

export type ReviewFindingSeverity = "blocking" | "suggestion";
export type ReviewFindingCategory =
  | "security"
  | "correctness"
  | "regression"
  | "acceptance-criteria"
  | "test-coverage"
  | "style";

export interface ReviewFinding {
  severity: ReviewFindingSeverity;
  category: ReviewFindingCategory;
  file: string | null;
  line: number | null;
  message: string;
}

/**
 * Static review instructions — byte-identical on every review call, so it's
 * a stable cacheable systemPrompt prefix rather than being re-billed as part
 * of every diff-specific prompt.
 */
const REVIEW_SYSTEM_PROMPT = [
  "You are reviewing an accessibility fix diff. You did NOT write this code.",
  "Check the changed lines for: correctness bugs, security issues (XSS, injection),",
  "unrelated/off-scope changes, missing test coverage, and whether the diff satisfies",
  "the ticket's acceptance criteria (if provided). Accessibility fixes often touch HTML",
  "attributes, ARIA labels, color contrast, focus management, and semantic elements —",
  "these are expected and valid, do not flag them as off-scope.",
  "",
  "Respond with ONLY a JSON array (no prose, no markdown fences) of finding objects:",
  '[{"severity": "blocking"|"suggestion", "category": "security"|"correctness"|"regression"|"acceptance-criteria"|"test-coverage"|"style", "file": string|null, "line": number|null, "message": string}]',
  "",
  "severity classification:",
  '- "blocking": security vulnerabilities, correctness bugs that would break the app,',
  "  failing/unmet acceptance criteria, real regressions to existing behavior.",
  '- "suggestion": style preferences, naming choices, minor cleanups, anything that',
  "  is a matter of opinion and would not break the application.",
  "",
  "If the diff has no findings at all, respond with exactly: []",
].join("\n");

function parseFindings(raw: string): ReviewFinding[] {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "[]" || /^LGTM$/i.test(trimmed)) return [];

  const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
  const jsonText = jsonMatch ? jsonMatch[0] : trimmed;

  try {
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((f) => f && typeof f.message === "string")
      .map((f) => ({
        severity: f.severity === "blocking" ? "blocking" : "suggestion",
        category: (["security", "correctness", "regression", "acceptance-criteria", "test-coverage", "style"] as const).includes(f.category)
          ? f.category
          : "style",
        file: typeof f.file === "string" ? f.file : null,
        line: typeof f.line === "number" ? f.line : null,
        message: String(f.message).slice(0, 2000),
      }));
  } catch {
    // Model didn't return valid JSON — treat as a single non-blocking finding
    // so the concern isn't silently lost, but nothing blocks on a parse failure.
    return [{ severity: "suggestion", category: "style", file: null, line: null, message: trimmed.slice(0, 2000) }];
  }
}

/**
 * Adversarial code review — a separate persona/context from the Developer
 * agent, per architecture doc §02: it must not be the same session that
 * wrote the fix. Returns structured, severity-classified findings; an empty
 * array means LGTM. Only "blocking" findings gate PR approval — "suggestion"
 * findings are posted as comments but don't block merge.
 */
export async function adversarialReview(worktreeDir: string, acceptanceCriteria?: string): Promise<ReviewFinding[]> {
  if (!process.env.ANTHROPIC_API_KEY) return [];

  try {
    const { stdout: diff } = await run("git", ["diff", QA_BRANCH, "--", "."], worktreeDir);
    if (!diff.trim()) return [];

    const acSection = acceptanceCriteria
      ? `\n\nTicket acceptance criteria:\n${acceptanceCriteria.slice(0, 3000)}`
      : "";
    const prompt = `Diff (changed files only):\n${diff.slice(0, 20000)}${acSection}`;

    let reviewText = "";
    await traceAnthropicAgentSdkQuery({
      agent_name: "reviewer",
      operation_name: "review_changes",
      model_name: REVIEWER_MODEL,
      inputs: {
        operation_name: "review_changes",
        diff_length: diff.length,
      },
      prompt,
      sdkOptions: {
        allowedTools: [],
        model: REVIEWER_MODEL,
        effort: REVIEWER_EFFORT,
        systemPrompt: REVIEW_SYSTEM_PROMPT,
      },
      onAssistantMessage: (content) => {
        // `content` is the raw SDK content-block array, which may include
        // "thinking" blocks when extended thinking is on — only the "text"
        // blocks hold the model's actual JSON findings response.
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "text" && typeof block.text === "string") {
              reviewText += block.text;
            }
          }
        } else if (typeof content === "string") {
          reviewText += content;
        }
      },
    });

    const findings = parseFindings(reviewText);
    if (findings.length > 0) {
      logger.warn(`adversarial-review`, `${findings.length} finding(s) raised (${findings.filter((f) => f.severity === "blocking").length} blocking).`);
    }
    return findings;
  } catch (err) {
    logger.warn("adversarial-review", "Failed to run — not blocking on it.", err);
    return [];
  }
}
