import { run } from "../lib/exec.js";
import { REVIEWER_MODEL, REVIEWER_EFFORT } from "../lib/config.js";

const BASE_BRANCH = process.env.GITHUB_BASE_BRANCH ?? "master";

/**
 * Adversarial code review — a separate persona/context from the Developer
 * agent, per architecture doc §02: it must not be the same session that
 * wrote the fix. Returns a concern string if it found one, or null for LGTM.
 */
export async function adversarialReview(worktreeDir: string): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  try {
    const { stdout: diff } = await run("git", ["diff", BASE_BRANCH], worktreeDir);
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    let reviewText = "";
    // Verify the model/effort options against current Agent SDK docs — same
    // caveat as development/developer-agent.ts.
    for await (const message of query({
      prompt: [
        "You are reviewing someone else's accessibility fix. You did not write this code.",
        "Flag it ONLY if the diff is out of scope for the stated fix, introduces an obvious bug,",
        "or clearly regresses something unrelated. Otherwise respond with exactly: LGTM.",
        `\nDiff:\n${diff.slice(0, 20000)}`,
      ].join("\n"),
      options: { allowedTools: [], model: REVIEWER_MODEL, effort: REVIEWER_EFFORT },
    } as any)) {
      if ((message as any).type === "assistant") {
        reviewText += JSON.stringify((message as any).message?.content ?? "");
      }
    }
    return /LGTM/i.test(reviewText) ? null : reviewText.slice(0, 2000);
  } catch (err) {
    console.warn("[adversarial-review] Failed to run — not blocking on it.", err);
    return null;
  }
}
