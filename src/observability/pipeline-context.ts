import { AsyncLocalStorage } from "node:async_hooks";
import type { RunTree } from "langsmith/run_trees";

export type PipelineAgentName =
  | "scanner"
  | "triage"
  | "jira_sync"
  | "prepare_branch"
  | "developer"
  | "autofix"
  | "push_branch"
  | "reviewer"
  | "conflict_resolver"
  | "deploy"
  | "cleanup"
  | "release";

export interface AnthropicUsageSnapshot {
  agent_name: PipelineAgentName;
  operation_name: string;
  model_name: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  status: "success" | "error";
  retry_attempt?: number;
  /** When false the call is visible in LangSmith but excluded from root totals. */
  counts_toward_totals: boolean;
}

export interface AgentUsageTotals {
  anthropic_call_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface PipelineRootSummary extends AgentUsageTotals {
  models_used: string[];
  usage_by_agent: Record<PipelineAgentName, AgentUsageTotals>;
}

const EMPTY_AGENT_TOTALS = (): AgentUsageTotals => ({
  anthropic_call_count: 0,
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
});

export class UsageAccumulator {
  private readonly records: AnthropicUsageSnapshot[] = [];

  record(snapshot: AnthropicUsageSnapshot): void {
    this.records.push(snapshot);
  }

  recordCount(): number {
    return this.records.length;
  }

  totalsForAgentSince(agentName: PipelineAgentName, fromIndex: number): AgentUsageTotals {
    const totals = EMPTY_AGENT_TOTALS();
    for (let i = fromIndex; i < this.records.length; i++) {
      const record = this.records[i];
      if (!record.counts_toward_totals) continue;
      if (record.agent_name === agentName) {
        addTotals(totals, record);
      }
    }
    return totals;
  }

  modelsForAgentSince(agentName: PipelineAgentName, fromIndex: number): string[] {
    const models = new Set<string>();
    for (let i = fromIndex; i < this.records.length; i++) {
      const record = this.records[i];
      if (!record.counts_toward_totals) continue;
      if (record.agent_name === agentName) {
        models.add(record.model_name);
      }
    }
    return [...models].sort();
  }

  summarize(): PipelineRootSummary {
    const usage_by_agent = {
      scanner: EMPTY_AGENT_TOTALS(),
      triage: EMPTY_AGENT_TOTALS(),
      jira_sync: EMPTY_AGENT_TOTALS(),
      prepare_branch: EMPTY_AGENT_TOTALS(),
      developer: EMPTY_AGENT_TOTALS(),
      autofix: EMPTY_AGENT_TOTALS(),
      push_branch: EMPTY_AGENT_TOTALS(),
      reviewer: EMPTY_AGENT_TOTALS(),
      conflict_resolver: EMPTY_AGENT_TOTALS(),
      deploy: EMPTY_AGENT_TOTALS(),
      cleanup: EMPTY_AGENT_TOTALS(),
      release: EMPTY_AGENT_TOTALS(),
    };

    const models = new Set<string>();
    let summary = EMPTY_AGENT_TOTALS();

    for (const record of this.records) {
      if (!record.counts_toward_totals) continue;
      models.add(record.model_name);
      addTotals(summary, record);
      addTotals(usage_by_agent[record.agent_name], record);
    }

    return {
      ...summary,
      models_used: [...models].sort(),
      usage_by_agent,
    };
  }
}

function addTotals(target: AgentUsageTotals, record: AnthropicUsageSnapshot): void {
  target.anthropic_call_count += 1;
  target.input_tokens += record.input_tokens;
  target.output_tokens += record.output_tokens;
  target.total_tokens += record.total_tokens;
}

export interface PipelineContext {
  pipeline_run_id: string;
  cycle_number: number;
  accumulator: UsageAccumulator;
  /** Root "ForgeAI" LangSmith run — agent runs attach here directly, bypassing LangGraph's internal run tree. */
  root_run_tree?: RunTree;
}

const storage = new AsyncLocalStorage<PipelineContext>();

export function runWithPipelineContext<T>(
  init: { pipeline_run_id: string; cycle_number?: number },
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(
    {
      pipeline_run_id: init.pipeline_run_id,
      cycle_number: init.cycle_number ?? 0,
      accumulator: new UsageAccumulator(),
    },
    fn,
  );
}

export function getPipelineContext(): PipelineContext | undefined {
  return storage.getStore();
}

export function setPipelineCycleNumber(cycleNumber: number): void {
  const ctx = storage.getStore();
  if (ctx) ctx.cycle_number = cycleNumber;
}

export function setPipelineRootRunTree(runTree: RunTree): void {
  const ctx = storage.getStore();
  if (ctx) ctx.root_run_tree = runTree;
}

export function recordAnthropicUsage(snapshot: AnthropicUsageSnapshot): void {
  try {
    getPipelineContext()?.accumulator.record(snapshot);
  } catch {
    // tracing must not break the pipeline
  }
}

export function getPipelineRootSummary(): PipelineRootSummary | null {
  try {
    return getPipelineContext()?.accumulator.summarize() ?? null;
  } catch {
    return null;
  }
}
