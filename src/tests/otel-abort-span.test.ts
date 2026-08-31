/**
 * A client that disconnects mid-request fires neither `finish` nor `error` —
 * `src/http/index.ts` handles that via `res.on("close", ...)`. Two invariants
 * on that path:
 *
 *  1. `http.response.status_code` must not report the pre-`writeHead` `200`
 *     default when no response was ever sent (self-contradicts
 *     `agentswarm.http.aborted: true`).
 *  2. The span status must stay Unset — OTel HTTP semconv reserves ERROR for
 *     5xx, and a client abort is the normal SSE teardown path for /mcp and
 *     /mcp-user.
 *
 * (1) is a pure function (`abortedStatusCodeAttribute`), tested directly.
 * (2) lives at module scope in `src/http/index.ts`, which binds a port on
 * import (see `shutdown-error-scrubbing.test.ts`), so the source is read
 * rather than executed.
 */

import { describe, expect, test } from "bun:test";
import { abortedStatusCodeAttribute } from "../http/utils";

const indexSourcePath = `${import.meta.dir}/../http/index.ts`;
const indexSource = await Bun.file(indexSourcePath).text();
const closeHandlerMatch = indexSource.match(/res\.on\("close", \(\) => \{[\s\S]*?\n {6}\}\);/);

describe("abortedStatusCodeAttribute", () => {
  test("omits the status code when no response was ever sent", () => {
    expect(abortedStatusCodeAttribute(false, 200)).toBeUndefined();
  });

  test("reports the real status code once headers were sent", () => {
    expect(abortedStatusCodeAttribute(true, 404)).toBe(404);
  });
});

describe("close-handler span status (source check)", () => {
  test("the close handler exists and computes the status via abortedStatusCodeAttribute", () => {
    expect(closeHandlerMatch).not.toBeNull();
    expect(closeHandlerMatch?.[0]).toContain(
      "abortedStatusCodeAttribute(res.headersSent, statusCode)",
    );
  });

  test("the close handler never calls span.setStatus", () => {
    expect(closeHandlerMatch?.[0]).not.toContain("setStatus");
  });

  test("the close handler still sets agentswarm.http.aborted", () => {
    expect(closeHandlerMatch?.[0]).toContain('"agentswarm.http.aborted": true');
  });
});
