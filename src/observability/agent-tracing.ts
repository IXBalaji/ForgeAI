import { traceable, getCurrentRunTree } from "langsmith/traceable";
import { getPipelineContext } from "./pipeline-context.js";
import type { PipelineAgentName } from "./pipeline-context.js";

function isLangSmithTracingEnabled(): boolean {
  const tracingEnabled =
    process.env.LANGSMITH_TRACING_V2 ?? process.env.LANGCHAIN_TRACING_V2;
  return tracingEnabled === "true" && Boolean(
    process.env.LANGSMITH_API_KEY ?? process.env.LANGCHAIN_API_KEY,
  );
}

function pipelineMetadata(): Record<string, unknown> {
  const ctx = getPipelineContext();
  if (!ctx) return {};
  return {
    pipeline_run_id: ctx.pipeline_run_id,
    cycle_number: ctx.cycle_number,
  };
}

/**
 * Wrap one agent invocation as a LangSmith child run (agent.triage, agent.developer, …).
 * Falls back to a direct call when LangSmith tracing is disabled.
 */
export async function runAgentTrace<T>(
  agentName: PipelineAgentName,
  fn: () => Promise<T>,
  metadata?: Record<string, unknown>,
): Promise<T> {
  if (!isLangSmithTracingEnabled()) {
    return fn();
  }

  const ctx = getPipelineContext();
  const startIdx = ctx?.accumulator.recordCount() ?? 0;

  const runner = traceable(
    async () => {
      const result = await fn();

      try {
        if (ctx) {
          const totals = ctx.accumulator.totalsForAgentSince(agentName, startIdx);
          if (totals.anthropic_call_count > 0) {
            const models = ctx.accumulator.modelsForAgentSince(agentName, startIdx);
            const runTree = getCurrentRunTree();
            runTree.outputs = {
              ...(runTree.outputs ?? {}),
              input_tokens: totals.input_tokens,
              output_tokens: totals.output_tokens,
              total_tokens: totals.total_tokens,
              input_cost: totals.input_cost,
              output_cost: totals.output_cost,
              total_cost: totals.total_cost,
              currency: "USD",
              models_used: models,
              api_calls: totals.anthropic_call_count,
            };
            (runTree as any).prompt_tokens = totals.input_tokens;
            (runTree as any).completion_tokens = totals.output_tokens;
            (runTree as any).total_tokens = totals.total_tokens;
            runTree.extra = {
              ...runTree.extra,
              metadata: {
                ...(runTree.extra?.metadata as Record<string, unknown> ?? {}),
                input_tokens: totals.input_tokens,
                output_tokens: totals.output_tokens,
                total_tokens: totals.total_tokens,
                input_cost: totals.input_cost,
                output_cost: totals.output_cost,
                total_cost: totals.total_cost,
                models_used: models,
              },
            };
          }
        }
      } catch {
        // tracing must not break the pipeline
      }

      return result;
    },
    {
      name: `agent.${agentName}`,
      run_type: "chain",
      metadata: { ...pipelineMetadata(), ...metadata },
    },
  );
  return runner();
}
