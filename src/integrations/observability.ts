import "dotenv/config";
import { trace, SpanStatusCode } from "@opentelemetry/api";

// Verify this against the current @opentelemetry/sdk-node docs before relying
// on it — the NodeSDK constructor shape (traceExporter vs. spanProcessors)
// has changed across major versions, same unverified-API caveat as the
// Claude Agent SDK and LangGraph call sites elsewhere in this codebase.
let started = false;

export async function initObservability(serviceName = "a11y-agent-system"): Promise<void> {
  if (started) return;
  started = true;

  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { ConsoleSpanExporter, SimpleSpanProcessor, BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-node");

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  let exporter: InstanceType<typeof ConsoleSpanExporter>;
  if (endpoint) {
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    exporter = new OTLPTraceExporter({ url: endpoint }) as any;
  } else {
    exporter = new ConsoleSpanExporter();
    console.log("[observability] OTEL_EXPORTER_OTLP_ENDPOINT not set — tracing to console only.");
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
