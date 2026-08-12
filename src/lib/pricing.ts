export const MODEL_PRICING: Record<string, { inputPerMToken: number; outputPerMToken: number }> = {
  "claude-sonnet-5": { inputPerMToken: 3.0, outputPerMToken: 15.0 },
  "claude-sonnet-4-5-20250514": { inputPerMToken: 2.0, outputPerMToken: 10.0 },
  "claude-haiku-4-5-20251001": { inputPerMToken: 0.80, outputPerMToken: 4.0 },
  "claude-opus-4-6": { inputPerMToken: 15.0, outputPerMToken: 75.0 },
};

export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return (inputTokens / 1_000_000) * pricing.inputPerMToken
       + (outputTokens / 1_000_000) * pricing.outputPerMToken;
}
