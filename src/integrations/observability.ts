import "dotenv/config";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { LABEL_PREFIX_SLUG } from "../lib/config.js";
import { logger } from "../lib/logger.js";

// Verify this against the current @opentelemetry/sdk-node docs before relying
// on it — the NodeSDK constructor shape (traceExporter vs. spanProcessors)
// has changed across major versions, same unverified-API caveat as the
// Claude Agent SDK and LangGraph call sites elsewhere in this codebase.
let started = false;

/**
 * LangSmith tracing is env-var driven for anything LangChain/LangGraph-native
 * (the orchestrator graph itself) — setting LANGSMITH_TRACING_V2 is enough,
 * no code required for that part. LANGSMITH_* is the current name; the
 * installed `langsmith` SDK also accepts the older LANGCHAIN_* names for
 * backward compatibility (checked here too, but LANGSMITH_* wins if both are
 * set — same precedence the SDK itself uses). This fills in LANGSMITH_PROJECT
 * with a non-hardcoded default (matching every other per-project label in
 * this codebase — see lib/config.ts) when unset, and reports whether tracing
 * is actually active so a missing API key fails loud at startup instead of
 * silently tracing nothing.
 */
function initLangSmith(): void {
  const tracingEnabled = process.env.LANGSMITH_TRACING_V2 ?? process.env.LANGCHAIN_TRACING_V2;
  if (tracingEnabled !== "true") {
    logger.info("observability", "LANGSMITH_TRACING_V2 not set to \"true\" — LangSmith tracing is off.");
    return;
  }
  const apiKey = process.env.LANGSMITH_API_KEY ?? process.env.LANGCHAIN_API_KEY;
  if (!apiKey) {
    logger.warn("observability", "LANGSMITH_TRACING_V2=true but LANGSMITH_API_KEY is not set — LangSmith will drop traces silently.");
    return;
  }
  process.env.LANGSMITH_PROJECT ??= process.env.LANGCHAIN_PROJECT ?? `${LABEL_PREFIX_SLUG}-a11y-agents`;
  logger.info(`observability`, `LangSmith tracing on — project "${process.env.LANGSMITH_PROJECT}".`);
}

export async function initObservability(serviceName = "a11y-agent-system"): Promise<void> {
  if (started) return;
  started = true;

  initLangSmith();

  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { ConsoleSpanExporter, SimpleSpanProcessor, BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-node");

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  let exporter: InstanceType<typeof ConsoleSpanExporter>;
  if (endpoint) {
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    exporter = new OTLPTraceExporter({ url: endpoint }) as any;
  } else {
    exporter = new ConsoleSpanExporter();
    logger.info("observability", "OTEL_EXPORTER_OTLP_ENDPOINT not set — tracing to console only.");
  }

  const sdk = new NodeSDK({
    serviceName,
    spanProcessors: [endpoint ? new BatchSpanProcessor(exporter as any) : new SimpleSpanProcessor(exporter as any)],
  } as any);
  sdk.start();
}

const tracer = trace.getTracer("a11y-agent-system");

/** Wraps one agent invocation in a span — this is the "one span per agent invocation" from the plan. */
export async function withSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}
