import "dotenv/config";
import { Client } from "langsmith";

interface AgentUsage {
  agent: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
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

    const key = `${agent}::${model}`;
    const existing = usageByKey.get(key);
    if (existing) {
      existing.inputTokens += inputTokens;
      existing.outputTokens += outputTokens;
      existing.totalTokens += totalTokens;
      existing.runCount += 1;
    } else {
      usageByKey.set(key, {
        agent,
        model,
        inputTokens,
        outputTokens,
        totalTokens,
        runCount: 1,
      });
    }
  }

  const rows = [...usageByKey.values()].sort((a, b) => b.totalTokens - a.totalTokens);

  const startStr = startTime.toISOString().split("T")[0];
  const endStr = endDate.toISOString().split("T")[0];

  console.log(`\n${"=".repeat(100)}`);
  console.log(`  AI Token Usage Report`);
  console.log(`  Period: ${startStr} to ${endStr}  |  Project: ${projectName}`);
  console.log(`  Cost breakdown is available in the LangSmith UI for this project.`);
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
  ].join("  ");

  console.log(`  ${header}`);
  console.log(`  ${"-".repeat(header.length)}`);

  let totalInput = 0;
  let totalOutput = 0;
  let totalRuns = 0;

  for (const row of rows) {
    totalInput += row.inputTokens;
    totalOutput += row.outputTokens;
    totalRuns += row.runCount;

    const line = [
      row.agent.padEnd(35),
      row.model.padEnd(30),
      String(row.runCount).padStart(6),
      row.inputTokens.toLocaleString().padStart(14),
      row.outputTokens.toLocaleString().padStart(15),
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
  ].join("  ");
  console.log(`  ${totalLine}`);
  console.log();

  const byModel = new Map<string, { input: number; output: number; runs: number }>();
  for (const row of rows) {
    const m = byModel.get(row.model) ?? { input: 0, output: 0, runs: 0 };
    m.input += row.inputTokens;
    m.output += row.outputTokens;
    m.runs += row.runCount;
    byModel.set(row.model, m);
  }

  console.log(`  Model Summary:`);
  for (const [model, m] of byModel) {
    console.log(`    ${model}: ${m.runs} runs, ${m.input.toLocaleString()} in / ${m.output.toLocaleString()} out`);
  }
  console.log();
}
