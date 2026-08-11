import { traceable, getCurrentRunTree } from "langsmith/traceable";
import { run } from "../lib/exec.js";
import { REVIEWER_MODEL, REVIEWER_EFFORT } from "../lib/config.js";

const QA_BRANCH = `origin/${process.env.GITHUB_QA_BRANCH ?? "qa"}`;

/**
 * Adversarial code review — a separate persona/context from the Developer
 * agent, per architecture doc §02: it must not be the same session that
 * wrote the fix. Returns a concern string if it found one, or null for LGTM.
 *
 * traceable so this model call (not LangChain-native, so invisible to
 * LangSmith's automatic LangGraph tracing) shows up nested under the
 * Reviewer node's run with its full diff-in/verdict-out.
 */
export const adversarialReview = traceable(_adversarialReview, {
  name: "adversarial-review-sdk-call",
  run_type: "llm",
  metadata: { model: REVIEWER_MODEL, ls_model_name: REVIEWER_MODEL, ls_provider: "anthropic" },
});

async function _adversarialReview(worktreeDir: string): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  try {
    const { stdout: diff } = await run("git", ["diff", QA_BRANCH, "--", "."], worktreeDir);
    if (!diff.trim()) return null;

    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    let reviewText = "";
    for await (const message of query({
      prompt: [
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
      ].join("\n"),
      options: { allowedTools: [], model: REVIEWER_MODEL, effort: REVIEWER_EFFORT },
    } as any)) {
      if ((message as any).type === "assistant") {
        reviewText += JSON.stringify((message as any).message?.content ?? "");
      }
      if ((message as any).type === "result") {
        attachSdkUsage(message as any);
      }
    }
    const isLgtm = /LGTM/i.test(reviewText);
    if (isLgtm) return null;
    console.warn("[adversarial-review] Concern raised:", reviewText.slice(0, 500));
    return reviewText.slice(0, 2000);
  } catch (err) {
    console.warn("[adversarial-review] Failed to run — not blocking on it.", err);
    return null;
  }
}

function attachSdkUsage(result: {
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>;
  num_turns?: number;
}): void {
  try {
    const runTree = getCurrentRunTree();
    const usage = result.usage;
    if (usage) {
      const inputTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      const outputTokens = usage.output_tokens ?? 0;
      (runTree as any).prompt_tokens = inputTokens;
      (runTree as any).completion_tokens = outputTokens;
      (runTree as any).total_tokens = inputTokens + outputTokens;
      runTree.outputs = { total_cost_usd: result.total_cost_usd, num_turns: result.num_turns, model_breakdown: result.modelUsage };
      const modelNames = Object.keys(result.modelUsage ?? {});
      if (modelNames.length > 0) {
        runTree.extra = {
          ...runTree.extra,
          metadata: { ...(runTree.extra?.metadata as Record<string, unknown> ?? {}), ls_model_name: modelNames[0], ls_provider: "anthropic", sdk_total_cost_usd: result.total_cost_usd },
        };
      }
    }
  } catch { /* best effort */ }
}
