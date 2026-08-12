import { withRunTree } from "langsmith/traceable";
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
 * Wrap one agent invocation as a LangSmith run (agent.triage, agent.developer, …),
 * attached directly to the root "ForgeAI" run rather than whatever LangGraph node
 * happens to be executing — keeps agent.* runs visible without LangGraph's internal
 * _start_/ChannelWrite/node-wrapper plumbing in between.
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
  const rootRunTree = ctx?.root_run_tree;
  if (!ctx || !rootRunTree) {
    return fn();
  }

  const startIdx = ctx.accumulator.recordCount();
  const runTree = rootRunTree.createChild({
    name: `agent.${agentName}`,
    run_type: "chain",
    inputs: {},
    extra: { metadata: { ...pipelineMetadata(), ...metadata } },
  });

  try {
    const result = await withRunTree(runTree, fn);

    const totals = ctx.accumulator.totalsForAgentSince(agentName, startIdx);
    const outputs: Record<string, unknown> = { completion_status: "success" };
    if (totals.anthropic_call_count > 0) {
      const models = ctx.accumulator.modelsForAgentSince(agentName, startIdx);
      Object.assign(outputs, {
        input_tokens: totals.input_tokens,
        output_tokens: totals.output_tokens,
        total_tokens: totals.total_tokens,
        input_cost: totals.input_cost,
        output_cost: totals.output_cost,
        total_cost: totals.total_cost,
        currency: "USD",
        models_used: models,
        api_calls: totals.anthropic_call_count,
      });
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

    runTree.outputs = outputs;
    await runTree.end(outputs);
    try {
      await runTree.postRun();
    } catch {
      // tracing must not break the pipeline
    }

    return result;
  } catch (err) {
    try {
      await runTree.end(undefined, (err as Error).message);
      await runTree.postRun();
    } catch {
      // tracing must not break the pipeline
    }
    throw err;
  }
}
