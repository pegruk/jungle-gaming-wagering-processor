import { context, propagation, SpanStatusCode, trace } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import type { EventContext } from "../../domain/events/integration-event";

export function startTelemetry(): NodeSDK | undefined {
  if (process.env.OTEL_ENABLED !== "true") return undefined;
  const sdk = new NodeSDK({
    serviceName: "wagering-processor",
    traceExporter: new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || "http://localhost:4318/v1/traces",
      timeoutMillis: 3000,
    }),
  });
  sdk.start();
  return sdk;
}

export async function traced<T>(
  name: string,
  eventContext: EventContext,
  action: (ctx: EventContext) => Promise<T>,
): Promise<T> {
  const parent = propagation.extract(
    context.active(),
    eventContext.traceparent ? { traceparent: eventContext.traceparent } : {},
  );
  return trace
    .getTracer("jungle-wagering", "1.0")
    .startActiveSpan(name, {}, parent, async (span) => {
      span.setAttribute("correlationId", eventContext.correlationId);
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier);
      try {
        return await action({
          ...eventContext,
          ...(carrier.traceparent ? { traceparent: carrier.traceparent } : {}),
        });
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
}

export function log(event: string, fields: Record<string, unknown>): void {
  if (process.env.LOG_LEVEL === "silent") return;
  process.stdout.write(
    JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields }) + "\n",
  );
}
