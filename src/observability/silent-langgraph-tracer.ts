import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";

/**
 * Suppresses LangGraph's automatic internal run tracing (_start_, ChannelWrite,
 * per-node wrapper runs, branch decisions, ...). Registering a handler already
 * named "langchain_tracer" prevents LangChain from injecting its own default
 * LangChainTracer (see @langchain/core CallbackManager._configureSync), so this
 * becomes the only tracer for the graph invocation — and it never persists anything.
 *
 * Safe because agent.* / anthropic.* runs (see agent-tracing.ts, anthropic-tracing.ts)
 * attach directly to the root "ForgeAI" run and do not depend on the graph's own
 * run tree being posted to LangSmith.
 */
export class SilentLangGraphTracer extends LangChainTracer {
  async onRunCreate(): Promise<void> {}
  async onRunUpdate(): Promise<void> {}
}
