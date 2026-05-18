import {
  context,
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import pkg from "../package.json";
import type { SwarmSpan } from "./otel";
import { scrubSecrets } from "./utils/secret-scrubber";

type AttributeValue = string | number | boolean | string[] | number[] | boolean[];
type Attributes = Record<string, AttributeValue | undefined>;

const TRACER_NAME = "agent-swarm";
const RAW_SPAN = Symbol("agent-swarm.raw-span");

let sdk: NodeSDK | undefined;

function decodeResourceAttributeValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseResourceAttributes(value = process.env.OTEL_RESOURCE_ATTRIBUTES): Attributes {
  if (!value) return {};
  const attributes: Attributes = {};
  for (const pair of value.split(",")) {
    const [rawKey, ...rawValueParts] = pair.split("=");
    const key = rawKey?.trim();
    if (!key) continue;
    const rawValue = rawValueParts.join("=").trim();
    if (!rawValue) continue;
    attributes[key] = decodeResourceAttributeValue(rawValue);
  }
  return attributes;
}

function cleanAttributes(attributes?: Attributes): Record<string, AttributeValue> | undefined {
  if (!attributes) return undefined;
  const cleaned: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) cleaned[key] = value;
  }
  return cleaned;
}

export function scrubOtelException(error: unknown): Error | string {
  if (!(error instanceof Error)) {
    return scrubSecrets(String(error));
  }

  const scrubbed = new Error(scrubSecrets(error.message));
  scrubbed.name = error.name;
  if (error.stack) {
    scrubbed.stack = scrubSecrets(error.stack);
  }
  return scrubbed;
}

export function scrubOtelStatus(status: { code: number; message?: string }) {
  return status.message === undefined
    ? status
    : {
        ...status,
        message: scrubSecrets(status.message),
      };
}

type AdaptedSwarmSpan = SwarmSpan & { [RAW_SPAN]: Span };

function spanAdapter(span: Span): AdaptedSwarmSpan {
  return {
    [RAW_SPAN]: span,
    setAttribute(key, value) {
      span.setAttribute(key, value);
      return this;
    },
    setAttributes(attributes) {
      const cleaned = cleanAttributes(attributes);
      if (cleaned) span.setAttributes(cleaned);
      return this;
    },
    addEvent(name, attributes) {
      const cleaned = cleanAttributes(attributes);
      span.addEvent(name, cleaned);
      return this;
    },
    recordException(error) {
      span.recordException(scrubOtelException(error));
    },
    setStatus(status) {
      span.setStatus(scrubOtelStatus(status));
      return this;
    },
    end() {
      span.end();
    },
  };
}

export async function boot(serviceRole: string): Promise<void> {
  if (sdk) return;

  const configuredResourceAttributes = parseResourceAttributes();
  const deploymentEnvironment =
    configuredResourceAttributes["deployment.environment"] || process.env.NODE_ENV || "development";
  const serviceName =
    process.env.OTEL_SERVICE_NAME ||
    (serviceRole === "api" ? "agent-swarm-api" : "agent-swarm-worker");
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      ...configuredResourceAttributes,
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: pkg.version,
      "service.namespace": configuredResourceAttributes["service.namespace"] || "agent-swarm",
      "service.instance.id": process.env.AGENT_ID || crypto.randomUUID(),
      "deployment.environment": deploymentEnvironment,
      env: configuredResourceAttributes.env || deploymentEnvironment,
      "agentswarm.service.role": serviceRole,
    }),
    traceExporter: new OTLPTraceExporter(),
  });

  sdk.start();

  const shutdown = async () => {
    try {
      await sdk?.shutdown();
    } catch {
      // Best-effort flush during process shutdown.
    }
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

export async function shutdown(): Promise<void> {
  await sdk?.shutdown();
  sdk = undefined;
}

export async function withSpan<T>(
  name: string,
  fn: (span: SwarmSpan) => Promise<T> | T,
  attributes?: Attributes,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, { attributes: cleanAttributes(attributes) }, async (span) => {
    try {
      const result = await fn(spanAdapter(span));
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(scrubOtelException(error));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: scrubSecrets(error instanceof Error ? error.message : String(error)),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function startSpan(name: string, attributes?: Attributes): SwarmSpan {
  const span = trace.getTracer(TRACER_NAME).startSpan(name, {
    attributes: cleanAttributes(attributes),
  });
  return spanAdapter(span);
}

export function withSpanContext<T>(span: SwarmSpan, fn: () => T): T {
  const rawSpan = (span as Partial<AdaptedSwarmSpan>)[RAW_SPAN];
  if (!rawSpan) return fn();
  return context.with(trace.setSpan(context.active(), rawSpan), fn);
}

export async function withRemoteContext<T>(
  carrier: Record<string, unknown>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const remoteContext = propagation.extract(ROOT_CONTEXT, carrier);
  return context.with(remoteContext, fn);
}

export function injectTraceContext(headers: Record<string, string>): Record<string, string> {
  propagation.inject(context.active(), headers);
  return headers;
}
