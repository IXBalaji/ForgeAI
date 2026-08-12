import { traceable } from "langsmith/traceable";
import { RunTree } from "langsmith/run_trees";
function isLangSmithTracingEnabled(): boolean {
  const tracingEnabled =
    process.env.LANGSMITH_TRACING_V2 ?? process.env.LANGCHAIN_TRACING_V2;
  return tracingEnabled === "true" && Boolean(
    process.env.LANGSMITH_API_KEY ?? process.env.LANGCHAIN_API_KEY,
  );
}
import { getCurrentRunTree } from "langsmith/traceable";
import type Anthropic from "@anthropic-ai/sdk";
import { calculateCost } from "../lib/pricing.js";
import { sanitizeForTrace } from "./sanitize.js";
import {
  getPipelineContext,
  recordAnthropicUsage,
  setPipelineRootRunTree,
  type PipelineAgentName,
} from "./pipeline-context.js";

export interface AnthropicTraceOptions {
  agent_name: PipelineAgentName;
  operation_name: string;
  model_name: string;
  issue_id?: string | null;
  retry_attempt?: number;
  counts_toward_totals?: boolean;
}

export interface SdkUsageResult {
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      costUSD?: number;
    }
  >;
  num_turns?: number;
  duration_ms?: number;
}

function buildTraceMetadata(options: AnthropicTraceOptions): Record<string, unknown> {
  const ctx = getPipelineContext();
  return {
    agent_name: options.agent_name,
    operation_name: options.operation_name,
    model_name: options.model_name,
    ls_model_name: options.model_name,
    ls_provider: "anthropic",
    provider: "anthropic",
    pipeline_run_id: ctx?.pipeline_run_id,
    cycle_number: ctx?.cycle_number,
    issue_id: options.issue_id ?? undefined,
    retry_attempt: options.retry_attempt,
  };
}

function splitSdkCosts(
  modelName: string,
  inputTokens: number,
  outputTokens: number,
  totalCostUsd?: number,
  modelUsage?: SdkUsageResult["modelUsage"],
): { input_cost: number; output_cost: number; total_cost: number } {
  const modelBreakdown = modelUsage?.[modelName];
  if (modelBreakdown?.costUSD != null && modelBreakdown.costUSD > 0) {
    const total = modelBreakdown.costUSD;
    const denom = inputTokens + outputTokens;
    if (denom <= 0) return { input_cost: 0, output_cost: 0, total_cost: total };
    const input_cost = total * (inputTokens / denom);
    return { input_cost, output_cost: total - input_cost, total_cost: total };
  }
  if (totalCostUsd != null && totalCostUsd > 0) {
    const input_cost = calculateCost(modelName, inputTokens, 0);
    const output_cost = calculateCost(modelName, 0, outputTokens);
    const computed = input_cost + output_cost;
    if (computed > 0) {
      const scale = totalCostUsd / computed;
      return {
        input_cost: input_cost * scale,
        output_cost: output_cost * scale,
        total_cost: totalCostUsd,
      };
    }
    return { input_cost: 0, output_cost: 0, total_cost: totalCostUsd };
  }
  const input_cost = calculateCost(modelName, inputTokens, 0);
  const output_cost = calculateCost(modelName, 0, outputTokens);
  return { input_cost, output_cost, total_cost: input_cost + output_cost };
}

export function extractSdkTokenUsage(result: SdkUsageResult, fallbackModel: string): {
  model_name: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_cost: number;
  output_cost: number;
  total_cost: number;
} {
  const usage = result.usage;
  const modelNames = Object.keys(result.modelUsage ?? {});
  const model_name = modelNames[0] ?? fallbackModel;
  const input_tokens =
    (usage?.input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0);
  const output_tokens = usage?.output_tokens ?? 0;
  const total_tokens = input_tokens + output_tokens;
  const costs = splitSdkCosts(
    model_name,
    input_tokens,
    output_tokens,
    result.total_cost_usd,
    result.modelUsage,
  );
  return { model_name, input_tokens, output_tokens, total_tokens, ...costs };
}

function attachRunUsage(
  runTree: RunTree,
  modelName: string,
  inputTokens: number,
  outputTokens: number,
  costs: { input_cost: number; output_cost: number; total_cost: number },
  status: "success" | "error",
): void {
  const totalTokens = inputTokens + outputTokens;
  (runTree as RunTree & { prompt_tokens?: number }).prompt_tokens = inputTokens;
  (runTree as RunTree & { completion_tokens?: number }).completion_tokens = outputTokens;
  (runTree as RunTree & { total_tokens?: number }).total_tokens = totalTokens;

  runTree.extra = {
    ...runTree.extra,
    metadata: {
      ...(runTree.extra?.metadata as Record<string, unknown> ?? {}),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      input_cost: costs.input_cost,
      output_cost: costs.output_cost,
      total_cost: costs.total_cost,
      currency: "USD",
      completion_status: status,
      ls_model_name: modelName,
      ls_provider: "anthropic",
    },
  };
}

async function postAnthropicRun(
  runTree: RunTree | null,
  options: AnthropicTraceOptions,
  params: {
    inputs: Record<string, unknown>;
    outputs?: Record<string, unknown>;
    error?: string;
    modelName: string;
    inputTokens: number;
    outputTokens: number;
    costs: { input_cost: number; output_cost: number; total_cost: number };
    status: "success" | "error";
  },
): Promise<void> {
  if (!runTree) return;

  runTree.inputs = sanitizeForTrace(params.inputs) as Record<string, unknown>;
  if (params.error) {
    await runTree.end(undefined, params.error);
  } else {
    runTree.outputs = sanitizeForTrace({
      ...params.outputs,
      input_tokens: params.inputTokens,
      output_tokens: params.outputTokens,
      total_tokens: params.inputTokens + params.outputTokens,
      input_cost: params.costs.input_cost,
      output_cost: params.costs.output_cost,
      total_cost: params.costs.total_cost,
      currency: "USD",
      completion_status: params.status,
    }) as Record<string, unknown>;
    attachRunUsage(
      runTree,
      params.modelName,
      params.inputTokens,
      params.outputTokens,
      params.costs,
      params.status,
    );
    await runTree.end(runTree.outputs);
  }

  try {
    await runTree.postRun();
  } catch {
    // tracing must not break the pipeline
  }

  if (options.counts_toward_totals !== false) {
    recordAnthropicUsage({
      agent_name: options.agent_name,
      operation_name: options.operation_name,
      model_name: params.modelName,
      input_tokens: params.inputTokens,
      output_tokens: params.outputTokens,
      total_tokens: params.inputTokens + params.outputTokens,
      input_cost: params.costs.input_cost,
      output_cost: params.costs.output_cost,
      total_cost: params.costs.total_cost,
      currency: "USD",
      status: params.status,
      retry_attempt: options.retry_attempt,
      counts_toward_totals: true,
    });
  }
}

function createAnthropicChildRun(options: AnthropicTraceOptions, inputs: Record<string, unknown>): RunTree | null {
  if (!isLangSmithTracingEnabled()) return null;

  try {
    const parent = getCurrentRunTree();
    const name = `anthropic.${options.agent_name}.${options.operation_name}`;
    const metadata = buildTraceMetadata(options);
    const sanitizedInputs = sanitizeForTrace(inputs) as Record<string, unknown>;

    if (parent) {
      return parent.createChild({
        name,
        run_type: "llm",
        inputs: sanitizedInputs,
        extra: { metadata },
      });
    }

    return new RunTree({
      name,
      run_type: "llm",
      inputs: sanitizedInputs,
      extra: { metadata },
    });
  } catch {
    return null;
  }
}

/** Wrap a direct @anthropic-ai/sdk messages.create call with LangSmith tracing. */
export async function traceAnthropicMessagesCreate<T extends Anthropic.Message>(
  options: AnthropicTraceOptions,
  traceInputs: Record<string, unknown>,
  call: (client: Anthropic) => Promise<T>,
): Promise<T> {
  const runTree = createAnthropicChildRun(options, traceInputs);
  try {
    const client = new (await import("@anthropic-ai/sdk")).default();
    const response = await call(client);
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const input_cost = calculateCost(options.model_name, inputTokens, 0);
    const output_cost = calculateCost(options.model_name, 0, outputTokens);
    const costs = {
      input_cost,
      output_cost,
      total_cost: input_cost + output_cost,
    };

    await postAnthropicRun(runTree, options, {
      inputs: traceInputs,
      outputs: {
        response: sanitizeForTrace(
          response.content[0]?.type === "text" ? response.content[0].text : response.content,
        ),
        model: response.model,
      },
      modelName: response.model || options.model_name,
      inputTokens,
      outputTokens,
      costs,
      status: "success",
    });
    return response;
  } catch (err) {
    await postAnthropicRun(runTree, options, {
      inputs: traceInputs,
      error: (err as Error).message,
      modelName: options.model_name,
      inputTokens: 0,
      outputTokens: 0,
      costs: { input_cost: 0, output_cost: 0, total_cost: 0 },
      status: "error",
    });
    throw err;
  }
}

export interface AgentSdkQueryOptions {
  agent_name: PipelineAgentName;
  operation_name: string;
  model_name: string;
  issue_id?: string | null;
  inputs: Record<string, unknown>;
  prompt: string;
  sdkOptions: Record<string, unknown>;
  max_retries?: number;
  onAssistantMessage?: (message: unknown) => void;
}

/** Wrap a Claude Agent SDK query() call with LangSmith tracing and optional retries. */
export async function traceAnthropicAgentSdkQuery(opts: AgentSdkQueryOptions): Promise<void> {
  const maxRetries = opts.max_retries ?? 0;

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const isFinalAttempt = attempt >= maxRetries;
    const runTree = createAnthropicChildRun(
      {
        agent_name: opts.agent_name,
        operation_name: opts.operation_name,
        model_name: opts.model_name,
        issue_id: opts.issue_id,
        retry_attempt: attempt,
        counts_toward_totals: false,
      },
      {
        ...opts.inputs,
        prompt_summary: "(SDK agent session)",
        model: opts.model_name,
        retry_attempt: attempt,
      },
    );

    try {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      let sdkResult: SdkUsageResult | null = null;

      for await (const message of query({
        prompt: opts.prompt,
        options: opts.sdkOptions,
      } as any)) {
        if ((message as any).type === "assistant") {
          opts.onAssistantMessage?.((message as any).message?.content ?? message);
        }
        if ((message as any).type === "result") {
          sdkResult = message as SdkUsageResult;
        }
      }

      const traceOptions: AnthropicTraceOptions = {
        agent_name: opts.agent_name,
        operation_name: opts.operation_name,
        model_name: opts.model_name,
        issue_id: opts.issue_id,
        retry_attempt: attempt,
        counts_toward_totals: true,
      };

      if (sdkResult?.usage) {
        const usage = extractSdkTokenUsage(sdkResult, opts.model_name);
        await postAnthropicRun(runTree, traceOptions, {
          inputs: opts.inputs,
          outputs: {
            num_turns: sdkResult.num_turns,
            duration_ms: sdkResult.duration_ms,
            model_breakdown: sdkResult.modelUsage,
            total_cost_usd: sdkResult.total_cost_usd,
          },
          modelName: usage.model_name,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          costs: {
            input_cost: usage.input_cost,
            output_cost: usage.output_cost,
            total_cost: usage.total_cost,
          },
          status: "success",
        });
      } else {
        await postAnthropicRun(runTree, traceOptions, {
          inputs: opts.inputs,
          outputs: { note: "SDK session completed without usage metadata" },
          modelName: opts.model_name,
          inputTokens: 0,
          outputTokens: 0,
          costs: { input_cost: 0, output_cost: 0, total_cost: 0 },
          status: "success",
        });
      }
      return;
    } catch (err) {
      lastErr = err as Error;
      const traceOptions: AnthropicTraceOptions = {
        agent_name: opts.agent_name,
        operation_name: opts.operation_name,
        model_name: opts.model_name,
        issue_id: opts.issue_id,
        retry_attempt: attempt,
        counts_toward_totals: isFinalAttempt,
      };
      await postAnthropicRun(runTree, traceOptions, {
        inputs: opts.inputs,
        error: lastErr.message,
        modelName: opts.model_name,
        inputTokens: 0,
        outputTokens: 0,
        costs: { input_cost: 0, output_cost: 0, total_cost: 0 },
        status: "error",
      });

      const isRetryable = /timeout|ECONNRESET|529|overloaded|rate.limit|socket hang up/i.test(
        lastErr.message,
      );
      if (!isRetryable || isFinalAttempt) break;
      const delay = Math.min(1000 * 2 ** attempt, 30000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  if (lastErr) throw lastErr;
}

/** Attach aggregated Anthropic usage to the root pipeline LangSmith run. */
export function attachPipelineRootSummary(runTree: RunTree): void {
  try {
    const summary = getPipelineContext()?.accumulator.summarize();
    if (!summary) return;

    runTree.outputs = {
      ...(runTree.outputs ?? {}),
      anthropic_usage_summary: summary,
    };
    runTree.extra = {
      ...runTree.extra,
      metadata: {
        ...(runTree.extra?.metadata as Record<string, unknown> ?? {}),
        anthropic_call_count: summary.anthropic_call_count,
        input_tokens: summary.input_tokens,
        output_tokens: summary.output_tokens,
        total_tokens: summary.total_tokens,
        input_cost: summary.input_cost,
        output_cost: summary.output_cost,
        total_cost: summary.total_cost,
        currency: summary.currency,
        models_used: summary.models_used,
        usage_by_agent: summary.usage_by_agent,
      },
    };
  } catch {
    // tracing must not break the pipeline
  }
}

export const runIssueResolutionPipeline = traceable(
  async (fn: () => Promise<void>) => {
    const runTree = getCurrentRunTree();
    if (runTree) setPipelineRootRunTree(runTree);
    return fn();
  },
  {
    name: "ForgeAI",
    run_type: "chain",
    on_end: (runTree) => attachPipelineRootSummary(runTree),
  },
);
