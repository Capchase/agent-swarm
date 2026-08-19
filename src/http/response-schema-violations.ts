import { recordResponseSchemaViolation } from "../otel";

/**
 * Bounded-label counter for `respond()` response-schema violations.
 *
 * `respond()` fails open outside `bun test` — one corrupt row must never take
 * an endpoint down. Failing open made the violation INVISIBLE: the HTTP span
 * records an error only for `status >= 500` (`src/http/index.ts`), and the OTel
 * setup exports traces and metrics but no logs, so a recurring contract
 * violation looked like a healthy 200 plus a best-effort stderr line nobody
 * alerts on.
 *
 * Cardinality is bounded by construction: the key is `METHOD path status`,
 * where `path` is the route TEMPLATE (`/api/tasks/{id}`), never a raw path.
 * That is one series per declared route response, not one per request.
 *
 * The in-process tally is the deterministic test seam — OTel is disabled under
 * `bun test`, so a counter living only in `otel-impl` could not be asserted on.
 */

const state = globalThis as typeof globalThis & {
  __agentSwarmResponseSchemaViolations?: Map<string, number>;
};

function tally(): Map<string, number> {
  state.__agentSwarmResponseSchemaViolations ??= new Map();
  return state.__agentSwarmResponseSchemaViolations;
}

export interface ResponseSchemaViolationLabels {
  /** Uppercase HTTP method, e.g. `POST`. */
  method: string;
  /** Route template, e.g. `/api/tasks/{id}`. Never a raw request path. */
  route: string;
  /** The response status the handler was sending when the schema failed. */
  status: number;
}

/** Stable series key for one route response. */
function seriesKey(labels: ResponseSchemaViolationLabels): string {
  return `${labels.method} ${labels.route} ${labels.status}`;
}

/**
 * Count one violation. Increments the in-process tally and forwards to the
 * OTel counter when OTLP export is configured. Never throws: telemetry must
 * not be able to break a response that is already being sent.
 */
export function countResponseSchemaViolation(labels: ResponseSchemaViolationLabels): void {
  const key = seriesKey(labels);
  tally().set(key, (tally().get(key) ?? 0) + 1);
  try {
    recordResponseSchemaViolation(labels);
  } catch {
    // Telemetry is best-effort.
  }
}

/** Violations counted for one route response since boot. */
export function getResponseSchemaViolations(labels: ResponseSchemaViolationLabels): number {
  return tally().get(seriesKey(labels)) ?? 0;
}

/** Every counted series — for tests and diagnostics. */
export function getAllResponseSchemaViolations(): Record<string, number> {
  return Object.fromEntries(tally());
}

/** Test helper: drop every counted series. */
export function _resetResponseSchemaViolations(): void {
  tally().clear();
}
