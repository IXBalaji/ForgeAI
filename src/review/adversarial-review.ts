import { traceAnthropicAgentSdkQuery } from "../observability/anthropic-tracing.js";
import { run } from "../lib/exec.js";
import { REVIEWER_MODEL, REVIEWER_EFFORT } from "../lib/config.js";

const QA_BRANCH = `origin/${process.env.GITHUB_QA_BRANCH ?? "qa"}`;

/**
 * Adversarial code review — a separate persona/context from the Developer
 * agent, per architecture doc §02: it must not be the same session that
 * wrote the fix. Returns a concern string if it found one, or null for LGTM.
 */
export async function adversarialReview(worktreeDir: string): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  try {
    const { stdout: diff } = await run("git", ["diff", QA_BRANCH, "--", "."], worktreeDir);
    if (!diff.trim()) return null;

    const prompt = [
      "You are reviewing an accessibility fix diff. You did NOT write this code.",
      "Your job is to check ONLY the changed lines for:",
      "1. Obvious bugs (null refs, broken syntax, wrong variable names)",
      "2. Security issues (XSS, injection) in the changed code",
      "3. Changes that are completely unrelated to accessibility",
      "",
      "DO NOT flag: style preferences, missing tests, minor naming choices,",
      "code that could be 'better', or anything that is a matter of opinion.",
      "Accessibility fixes often touch HTML attributes, ARIA labels, color contrast,",
      "focus management, and semantic elements — these are expected and valid.",
      "",
      "If the diff is reasonable and does not have obvious bugs, respond with exactly: LGTM",
      "Only flag BLOCKING issues that would break the application.",
      `\nDiff (changed files only):\n${diff.slice(0, 20000)}`,
    ].join("\n");

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
      sdkOptions: { allowedTools: [], model: REVIEWER_MODEL, effort: REVIEWER_EFFORT },
      onAssistantMessage: (content) => {
        reviewText += JSON.stringify(content);
      },
    });

    const isLgtm = /LGTM/i.test(reviewText);
    if (isLgtm) return null;
    console.warn("[adversarial-review] Concern raised:", reviewText.slice(0, 500));
    return reviewText.slice(0, 2000);
  } catch (err) {
    console.warn("[adversarial-review] Failed to run — not blocking on it.", err);
    return null;
  }
}
