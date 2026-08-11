import "dotenv/config";
import { Client } from "langsmith";
import { calculateCost, MODEL_PRICING } from "../lib/pricing.js";

interface AgentUsage {
  agent: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  runCount: number;
}

export async function generateCostReport(options: {
  days?: number;
  project?: string;
}): Promise<void> {
  const days = options.days ?? 7;
  const projectName = options.project ?? process.env.LANGSMITH_PROJECT;

  if (!projectName) {
    console.error("[cost-report] No project specified. Set LANGSMITH_PROJECT in .env or pass --project.");
    return;
  }

  if (!process.env.LANGSMITH_API_KEY) {
    console.error("[cost-report] LANGSMITH_API_KEY is not set.");
    return;
  }

  const client = new Client();
  const startTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const endDate = new Date();

  const usageByKey = new Map<string, AgentUsage>();

  for await (const run of client.listRuns({
    projectName,
    runType: "llm",
    startTime,
  })) {
    const runName = run.name ?? "unknown";
    const isAnthropicRun = runName.startsWith("anthropic.");
    const agent = isAnthropicRun
      ? runName.split(".")[1] ?? "unknown"
      : runName;
    const metadata = (run.extra?.metadata ?? {}) as Record<string, unknown>;
    const model =
      (metadata.ls_model_name as string)
      ?? (metadata.model_name as string)
      ?? (metadata.model as string)
      ?? "unknown";

    const inputTokens =
      (metadata.input_tokens as number)
      ?? run.prompt_tokens
      ?? 0;
    const outputTokens =
      (metadata.output_tokens as number)
      ?? run.completion_tokens
      ?? 0;
    const totalTokens =
      (metadata.total_tokens as number)
      ?? run.total_tokens
      ?? (inputTokens + outputTokens);

    const metadataTotalCost = (metadata.total_cost as number) ?? 0;
    const sdkCost = (metadata.sdk_total_cost_usd as number) ?? 0;
    const computedCost = calculateCost(model, inputTokens, outputTokens);
    const cost = metadataTotalCost > 0 ? metadataTotalCost : sdkCost > 0 ? sdkCost : computedCost;

    const key = `${agent}::${model}`;
    const existing = usageByKey.get(key);
    if (existing) {
      existing.inputTokens += inputTokens;
      existing.outputTokens += outputTokens;
      existing.totalTokens += totalTokens;
      existing.cost += cost;
      existing.runCount += 1;
    } else {
      usageByKey.set(key, {
        agent,
        model,
        inputTokens,
        outputTokens,
        totalTokens,
        cost,
        runCount: 1,
      });
    }
  }

  const rows = [...usageByKey.values()].sort((a, b) => b.cost - a.cost);

  const startStr = startTime.toISOString().split("T")[0];
  const endStr = endDate.toISOString().split("T")[0];

  console.log(`\n${"=".repeat(100)}`);
  console.log(`  AI Token Usage & Cost Report`);
  console.log(`  Period: ${startStr} to ${endStr}  |  Project: ${projectName}`);
  console.log(`${"=".repeat(100)}\n`);

  if (rows.length === 0) {
    console.log("  No LLM runs found in this period.\n");
    return;
  }

  const header = [
    "Agent".padEnd(35),
    "Model".padEnd(30),
    "Runs".padStart(6),
    "Input Tokens".padStart(14),
    "Output Tokens".padStart(15),
    "Cost ($)".padStart(10),
  ].join("  ");

  console.log(`  ${header}`);
  console.log(`  ${"-".repeat(header.length)}`);

  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;
  let totalRuns = 0;

  for (const row of rows) {
    totalInput += row.inputTokens;
    totalOutput += row.outputTokens;
    totalCost += row.cost;
    totalRuns += row.runCount;

    const line = [
      row.agent.padEnd(35),
      row.model.padEnd(30),
      String(row.runCount).padStart(6),
      row.inputTokens.toLocaleString().padStart(14),
      row.outputTokens.toLocaleString().padStart(15),
      `$${row.cost.toFixed(4)}`.padStart(10),
    ].join("  ");
    console.log(`  ${line}`);
  }

  console.log(`  ${"-".repeat(header.length)}`);

  const totalLine = [
    "TOTAL".padEnd(35),
    "".padEnd(30),
    String(totalRuns).padStart(6),
    totalInput.toLocaleString().padStart(14),
    totalOutput.toLocaleString().padStart(15),
    `$${totalCost.toFixed(4)}`.padStart(10),
  ].join("  ");
  console.log(`  ${totalLine}`);
  console.log();

  const byModel = new Map<string, { input: number; output: number; cost: number; runs: number }>();
  for (const row of rows) {
    const m = byModel.get(row.model) ?? { input: 0, output: 0, cost: 0, runs: 0 };
    m.input += row.inputTokens;
    m.output += row.outputTokens;
    m.cost += row.cost;
    m.runs += row.runCount;
    byModel.set(row.model, m);
  }

  console.log(`  Model Summary:`);
  for (const [model, m] of byModel) {
    const pricing = MODEL_PRICING[model];
    const rateInfo = pricing ? ` (in: $${pricing.inputPerMToken}/M, out: $${pricing.outputPerMToken}/M)` : " (unknown pricing)";
    console.log(`    ${model}${rateInfo}: ${m.runs} runs, ${m.input.toLocaleString()} in / ${m.output.toLocaleString()} out = $${m.cost.toFixed(4)}`);
  }
  console.log();
}
