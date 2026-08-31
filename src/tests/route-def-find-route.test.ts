import { describe, expect, test } from "bun:test";

// Importing the barrel server side-effect loads every `route()` definition
// (handlers register themselves in `routeRegistry` at import time). Without
// this, the registry is empty and `findRoute` always returns undefined.
import "../http/tasks";
import "../http/agents";
import "../http/sessions";

import { describeRequestRoute, findRoute } from "../http/route-def";

describe("findRoute", () => {
  test("matches a parameterized GET /api/tasks/{id}", () => {
    const matched = findRoute("GET", ["api", "tasks", "abc-123"]);
    expect(matched).toBeDefined();
    expect(matched?.method).toBe("get");
    expect(matched?.path).toBe("/api/tasks/{id}");
  });

  test("matches the list endpoint GET /api/tasks", () => {
    const matched = findRoute("GET", ["api", "tasks"]);
    expect(matched).toBeDefined();
    expect(matched?.path).toBe("/api/tasks");
  });

  test("distinguishes verbs on the same path", () => {
    const got = findRoute("POST", ["api", "tasks"]);
    expect(got).toBeDefined();
    expect(got?.method).toBe("post");
    expect(got?.path).toBe("/api/tasks");
  });

  test("returns undefined for unknown paths", () => {
    expect(findRoute("GET", ["nope", "missing"])).toBeUndefined();
  });

  test("returns undefined for unknown methods on a known path", () => {
    // No PATCH handler on /api/tasks
    expect(findRoute("PATCH", ["api", "tasks"])).toBeUndefined();
  });

  test("returns undefined when method is missing", () => {
    expect(findRoute(undefined, ["api", "tasks"])).toBeUndefined();
  });
});

describe("describeRequestRoute", () => {
  test("matched route produces `{METHOD} {template}` (with {id} placeholder, not a raw UUID)", () => {
    const { spanName } = describeRequestRoute("GET", [
      "api",
      "tasks",
      "550e8400-e29b-41d4-a716-446655440000",
    ]);
    expect(spanName).toBe("GET /api/tasks/{id}");
    // Cardinality guard: never embed raw IDs in the span name.
    expect(spanName).not.toContain("550e8400");
  });

  test("matched route sets http.route to the bounded-cardinality template", () => {
    const { httpRoute } = describeRequestRoute("GET", [
      "api",
      "tasks",
      "550e8400-e29b-41d4-a716-446655440000",
    ]);
    // http.route is the template, never the raw UUID.
    expect(httpRoute).toBe("/api/tasks/{id}");
    expect(httpRoute).not.toContain("550e8400");
  });

  test("matched POST list endpoint sets spanName and http.route", () => {
    const desc = describeRequestRoute("POST", ["api", "tasks"]);
    expect(desc.spanName).toBe("POST /api/tasks");
    expect(desc.httpRoute).toBe("/api/tasks");
  });

  test("a core static route not declared via route() still gets http.route", () => {
    // /health isn't registered through route(), but it's a fixed literal path
    // (not a template), so CORE_ROUTE_TEMPLATES maps it to http.route too.
    const desc = describeRequestRoute("GET", ["health"]);
    expect(desc.spanName).toBe("GET /health");
    expect(desc.httpRoute).toBe("/health");
  });

  test("unmatched path with no core-route entry falls back to `{METHOD} /{firstSegment}` and omits http.route", () => {
    const desc = describeRequestRoute("GET", ["nope", "missing"]);
    expect(desc.spanName).toBe("GET /nope");
    // No fabricated value — http.route is omitted for genuinely unmatched paths.
    expect(desc.httpRoute).toBeUndefined();
  });

  test("unmatched deeper path still only uses the first segment, no http.route", () => {
    // Bounded cardinality: never `GET /mcp/<session-id>`. The core-route
    // template only matches the exact literal `/mcp`, not a deeper path under it.
    const desc = describeRequestRoute("POST", ["mcp", "session-xyz", "messages"]);
    expect(desc.spanName).toBe("POST /mcp");
    expect(desc.httpRoute).toBeUndefined();
  });

  test("the exact literal /mcp path gets http.route", () => {
    const desc = describeRequestRoute("POST", ["mcp"]);
    expect(desc.spanName).toBe("POST /mcp");
    expect(desc.httpRoute).toBe("/mcp");
  });

  test("a multi-segment core static route gets its full path as http.route", () => {
    const desc = describeRequestRoute("POST", ["internal", "reload-config"]);
    expect(desc.spanName).toBe("POST /internal/reload-config");
    expect(desc.httpRoute).toBe("/internal/reload-config");
  });

  test("known path with unknown method omits http.route", () => {
    // No PATCH handler on /api/tasks — must not fabricate a template.
    const desc = describeRequestRoute("PATCH", ["api", "tasks"]);
    expect(desc.httpRoute).toBeUndefined();
  });

  test("root path produces bare method", () => {
    const desc = describeRequestRoute("GET", []);
    expect(desc.spanName).toBe("GET");
    expect(desc.httpRoute).toBeUndefined();
  });

  test("missing method falls back to UNKNOWN", () => {
    expect(describeRequestRoute(undefined, []).spanName).toBe("UNKNOWN");
  });
});
