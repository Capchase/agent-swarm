import { z } from "zod";
import { scrubSecrets } from "./secret-scrubber";

/**
 * Shared validation-error contract.
 *
 * A validation failure is a client mistake, not a server fault. Before this
 * module every `.parse()` that threw INSIDE a handler — the `createTaskExtended`
 * choke point, `MetricDefinitionSchema.parse`, a tool handler behind the MCP
 * bridge — reached the central catch as an anonymous `Error` and was reported
 * as a 500 whose body carried no field, no constraint, and no received value.
 * A consumer could not self-correct from it.
 *
 * Every entrypoint now routes a validation failure through `toValidationError`
 * and renders it with `validationErrorBody`, so REST, the MCP bridge, and the
 * MCP tool registrar all emit the same expressive shape.
 *
 * Deliberately free of server-only imports (no `src/be/db`, no `bun:sqlite`):
 * `src/tools/utils.ts` pulls this in on the worker side too.
 */

/** Longest `received` echo we put on the wire, in characters. */
const MAX_RECEIVED_CHARS = 120;

/** One field-level constraint failure. */
export interface ValidationIssue {
  /** Dotted field path, or `<root>` when the failure is on the value itself. */
  path: string;
  /** Zod issue code — `too_big`, `invalid_type`, `custom`, … */
  code: string;
  /** Human-readable constraint message. */
  message: string;
  /** What the schema wanted, when the issue carries enough to say so. */
  expected?: string;
  /** What the caller actually sent — scrubbed and bounded. */
  received?: string;
}

/**
 * A client-correctable input failure. Carries the per-field issues so every
 * error boundary can render the same payload without re-deriving it, and so a
 * boundary can tell "the caller sent something invalid" apart from "we broke".
 */
export class ValidationError extends Error {
  readonly issues: ValidationIssue[];
  /** Optional label naming the surface that rejected, e.g. `createTaskExtended`. */
  readonly context?: string;

  constructor(message: string, issues: ValidationIssue[], context?: string) {
    super(message);
    this.name = "ValidationError";
    this.issues = issues;
    this.context = context;
  }
}

/**
 * Render an arbitrary value for the `received` field: scrubbed of secrets and
 * bounded, so an oversized or credential-bearing payload can never be echoed
 * back wholesale.
 */
function describeReceived(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  let rendered: string;
  if (typeof input === "string") {
    rendered = JSON.stringify(input);
  } else if (input === null || typeof input !== "object") {
    rendered = String(input);
  } else if (Array.isArray(input)) {
    rendered = `array(${input.length})`;
  } else {
    rendered = `object(${Object.keys(input as Record<string, unknown>).length} keys)`;
  }
  const scrubbed = scrubSecrets(rendered);
  return scrubbed.length > MAX_RECEIVED_CHARS
    ? `${scrubbed.slice(0, MAX_RECEIVED_CHARS)}…`
    : scrubbed;
}

/**
 * Describe the constraint a Zod issue failed, using only fields the issue
 * itself carries. Returns `undefined` when the issue code adds nothing beyond
 * its message (the message is always on the wire anyway).
 */
function describeExpected(issue: z.core.$ZodIssue): string | undefined {
  const anyIssue = issue as unknown as Record<string, unknown>;
  switch (issue.code) {
    case "invalid_type":
      return typeof anyIssue.expected === "string" ? anyIssue.expected : undefined;
    case "too_small":
      return typeof anyIssue.minimum === "number" || typeof anyIssue.minimum === "bigint"
        ? `${anyIssue.inclusive === false ? ">" : ">="} ${anyIssue.minimum}`
        : undefined;
    case "too_big":
      return typeof anyIssue.maximum === "number" || typeof anyIssue.maximum === "bigint"
        ? `${anyIssue.inclusive === false ? "<" : "<="} ${anyIssue.maximum}`
        : undefined;
    case "invalid_value":
      return Array.isArray(anyIssue.values)
        ? `one of ${anyIssue.values.map((v) => JSON.stringify(v)).join(", ")}`
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Map a `ZodError`'s issues to the wire shape. `pathPrefix` prepends a segment
 * so a schema parsed in isolation (for example the positional `task` argument
 * of `createTaskExtended`) still reports the field name the caller sent.
 */
export function formatZodIssues(error: z.ZodError, pathPrefix?: string): ValidationIssue[] {
  return error.issues.map((issue) => {
    const segments = [
      ...(pathPrefix ? [pathPrefix] : []),
      ...issue.path.map((p) => String(p)),
    ].filter((s) => s.length > 0);
    return {
      path: segments.length > 0 ? segments.join(".") : "<root>",
      code: issue.code,
      message: issue.message,
      expected: describeExpected(issue),
      received: describeReceived((issue as unknown as { input?: unknown }).input),
    };
  });
}

/** Build a `ValidationError` from a `ZodError`. */
export function validationErrorFromZod(
  error: z.ZodError,
  opts?: { pathPrefix?: string; context?: string },
): ValidationError {
  const issues = formatZodIssues(error, opts?.pathPrefix);
  return new ValidationError(summarizeIssues(issues), issues, opts?.context);
}

/** One-line summary listing every offending field, so a log line is useful too. */
export function summarizeIssues(issues: ValidationIssue[]): string {
  if (issues.length === 0) return "Validation error";
  return `Validation error: ${issues.map((i) => `${i.path}: ${i.message}`).join(", ")}`;
}

/**
 * The predicate every error boundary uses. Returns a `ValidationError` when
 * `err` is a client-input failure, `null` when it is anything else — a real
 * fault, which must keep its 500.
 */
export function toValidationError(err: unknown): ValidationError | null {
  if (err instanceof ValidationError) return err;
  if (err instanceof z.ZodError) return validationErrorFromZod(err);
  return null;
}

/** The JSON body shape a validation failure produces. */
export interface ValidationErrorBody {
  /**
   * Human-readable summary. Kept a plain string (and kept prefixed with
   * `Validation error`) so existing consumers of `{ error }` keep working —
   * `details` is additive.
   */
  error: string;
  details: ValidationIssue[];
}

/** Render a `ValidationError` as the wire body. */
export function validationErrorBody(error: ValidationError): ValidationErrorBody {
  return {
    error: error.context ? `${error.message} (in ${error.context})` : error.message,
    details: error.issues,
  };
}
