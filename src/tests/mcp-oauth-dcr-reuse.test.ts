import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { closeDb, createMcpServer, getDb, initDb } from "../be/db";
import { getMcpOAuthToken } from "../be/db-queries/mcp-oauth";
import { handleCore } from "../http/core";
import { handleMcpOAuth } from "../http/mcp-oauth";
import { getPathSegments, parseQueryParams } from "../http/utils";

// Regression coverage for the "GET /api/mcp-oauth/:id/authorize runs a NEW
// DCR registration on every call" defect. Uses the same dispatch() harness
// as mcp-oauth-manual-client.test.ts.

const API_KEY = "test-secret-key";
const TEST_DB_PATH = "./test-mcp-oauth-dcr-reuse.sqlite";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
}

type TestResponse = {
  status: number;
  text: string;
  headers: Record<string, string>;
  json: () => Promise<unknown>;
};

async function dispatch(path: string, init: RequestInit = {}): Promise<TestResponse> {
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.body !== undefined && !headers["Content-Type"])
    headers["Content-Type"] = "application/json";

  const req = Readable.from(init.body ? [Buffer.from(String(init.body))] : []) as IncomingMessage;
  req.method = init.method ?? "GET";
  req.url = path;
  req.headers = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );

  let status = 200;
  let text = "";
  const responseHeaders: Record<string, string> = {};
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader(name: string, value: number | string | readonly string[]) {
      responseHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
      return this;
    },
    writeHead(code: number, headersArg?: Record<string, number | string | readonly string[]>) {
      status = code;
      if (headersArg) {
        for (const [key, value] of Object.entries(headersArg)) {
          responseHeaders[key.toLowerCase()] = Array.isArray(value)
            ? value.join(", ")
            : String(value);
        }
      }
      this.headersSent = true;
      return this;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) text += String(chunk);
      this.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;

  const handledCore = await handleCore(req, res, undefined, API_KEY);
  if (!handledCore) {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const handled = await handleMcpOAuth(req, res, pathSegments, queryParams);
    if (!handled) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  }

  return {
    status,
    text,
    headers: responseHeaders,
    json: async () => JSON.parse(text),
  };
}

describe("MCP OAuth DCR client reuse", () => {
  let originalFetch: typeof fetch;
  let dcrCallCount = 0;
  let issuerHost = "as-1.example.test";
  let registrationPath = "/register-1";
  let tokenShouldFail: "" | "invalid_client" = "";
  let asScopesSupported: string[] = [];

  const MCP_URL = "https://mcp.example.test/mcp";

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    dcrCallCount = 0;
    issuerHost = "as-1.example.test";
    registrationPath = "/register-1";
    tokenShouldFail = "";
    asScopesSupported = [];
    process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
    process.env.MCP_OAUTH_ALLOW_PRIVATE_HOSTS = "false";
    process.env.PUBLIC_MCP_BASE_URL = "https://swarm.example.test";
    process.env.APP_URL = "https://dashboard.example.test";

    await removeDbFiles();
    initDb(TEST_DB_PATH);

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const href = input.toString();

      if (href === `${MCP_URL}/.well-known/oauth-protected-resource`) {
        // Not present on the resource itself for this fixture — force the
        // WWW-Authenticate probe path is skipped by just 404ing, and instead
        // answer PRMD directly under the resource base.
        return new Response("not found", { status: 404 });
      }
      if (href === "https://mcp.example.test/.well-known/oauth-protected-resource") {
        return Response.json({
          resource: MCP_URL,
          authorization_servers: [`https://${issuerHost}`],
        });
      }
      if (href === `https://${issuerHost}/.well-known/oauth-authorization-server`) {
        return Response.json({
          issuer: `https://${issuerHost}`,
          authorization_endpoint: `https://${issuerHost}/authorize`,
          token_endpoint: `https://${issuerHost}/token`,
          registration_endpoint: `https://${issuerHost}${registrationPath}`,
          scopes_supported: asScopesSupported,
        });
      }
      if (href === `https://${issuerHost}${registrationPath}` && init?.method === "POST") {
        dcrCallCount += 1;
        return Response.json(
          {
            client_id: `client-${issuerHost}-${dcrCallCount}`,
            client_secret: `secret-${issuerHost}-${dcrCallCount}`,
          },
          { status: 201 },
        );
      }
      if (href === `https://${issuerHost}/token` && init?.method === "POST") {
        if (tokenShouldFail === "invalid_client") {
          return Response.json(
            { error: "invalid_client", error_description: "client no longer recognized" },
            { status: 401 },
          );
        }
        return Response.json({
          access_token: "mock-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "mock-refresh-token",
          scope: "read",
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    closeDb();
    await removeDbFiles();
    delete process.env.MCP_OAUTH_ALLOW_PRIVATE_HOSTS;
    delete process.env.PUBLIC_MCP_BASE_URL;
    delete process.env.APP_URL;
  });

  async function authorizeUrl(mcpServerId: string, scopes?: string) {
    const qs = scopes ? `?scopes=${encodeURIComponent(scopes)}` : "";
    const res = await dispatch(`/api/mcp-oauth/${mcpServerId}/authorize-url${qs}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    const { providerUrl } = (await res.json()) as { providerUrl: string };
    return new URL(providerUrl);
  }

  test("two authorize calls before any callback completes reuse one DCR client_id", async () => {
    const server = createMcpServer({
      name: "reuse-basic",
      transport: "http",
      url: MCP_URL,
      scope: "swarm",
    });

    const first = await authorizeUrl(server.id);
    const second = await authorizeUrl(server.id);

    expect(dcrCallCount).toBe(1);
    expect(first.searchParams.get("client_id")).toBe(second.searchParams.get("client_id"));
    expect(first.searchParams.get("client_id")).toBe("client-as-1.example.test-1");
  });

  test("a changed issuer/registration endpoint forces re-registration", async () => {
    const server = createMcpServer({
      name: "reuse-issuer-change",
      transport: "http",
      url: MCP_URL,
      scope: "swarm",
    });

    const first = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(1);

    // Provider migrated to a new AS entirely.
    issuerHost = "as-2.example.test";
    registrationPath = "/register-2";

    const second = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(2);
    expect(first.searchParams.get("client_id")).not.toBe(second.searchParams.get("client_id"));
    expect(second.searchParams.get("client_id")).toMatch(/^client-as-2\.example\.test-/);
  });

  test("an invalidated stored client re-registers exactly once on the next authorize call (no loop)", async () => {
    const server = createMcpServer({
      name: "reuse-invalidate",
      transport: "http",
      url: MCP_URL,
      scope: "swarm",
    });

    const first = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(1);
    const state = first.searchParams.get("state")!;

    const callbackRes = await dispatch(
      `/api/mcp-oauth/callback?state=${encodeURIComponent(state)}&code=auth-code`,
    );
    expect(callbackRes.status).toBe(302);
    expect(getMcpOAuthToken(server.id)?.status).toBe("connected");
    expect(getMcpOAuthToken(server.id)?.dcrClientId).toBe("client-as-1.example.test-1");

    // Provider now rejects the stored client at the token endpoint (e.g. a
    // subsequent refresh). Simulate via the refresh route.
    tokenShouldFail = "invalid_client";
    const refreshRes = await dispatch(`/api/mcp-oauth/${server.id}/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({}),
    });
    expect(refreshRes.status).toBe(500);
    expect(getMcpOAuthToken(server.id)?.status).toBe("error");

    // The next /authorize call must register fresh exactly once (not reuse
    // the now-invalidated client, and not loop).
    tokenShouldFail = "";
    const third = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(2);
    expect(third.searchParams.get("client_id")).toBe("client-as-1.example.test-2");
    expect(third.searchParams.get("client_id")).not.toBe(first.searchParams.get("client_id"));

    // And a further call reuses THAT new client — invalidation doesn't loop.
    const fourth = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(2);
    expect(fourth.searchParams.get("client_id")).toBe(third.searchParams.get("client_id"));
  });

  test("two concurrent first authorize calls for the same connector+user register exactly one DCR client (no TOCTOU race)", async () => {
    const server = createMcpServer({
      name: "reuse-concurrent",
      transport: "http",
      url: MCP_URL,
      scope: "swarm",
    });

    // Delay the DCR registration response so two concurrent callers are
    // guaranteed to overlap inside the check-reusable-then-register critical
    // section if it isn't serialized.
    const baseFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const href = input.toString();
      if (href === `https://${issuerHost}${registrationPath}` && init?.method === "POST") {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return baseFetch(input, init);
    }) as typeof fetch;

    const [a, b] = await Promise.all([authorizeUrl(server.id), authorizeUrl(server.id)]);

    expect(dcrCallCount).toBe(1);
    expect(a.searchParams.get("client_id")).toBe(b.searchParams.get("client_id"));

    // The persisted app row must not have been split/corrupted by the race —
    // a subsequent call keeps reusing the same single client.
    const third = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(1);
    expect(third.searchParams.get("client_id")).toBe(a.searchParams.get("client_id"));
  });

  test("a requested scope not covered by the stored client forces re-registration", async () => {
    const server = createMcpServer({
      name: "reuse-scope-change",
      transport: "http",
      url: MCP_URL,
      scope: "swarm",
    });

    // First call has no explicit scope request — the fixture's PRMD/AS
    // metadata advertises no scopes_supported, so the client registers with
    // no scope restriction recorded.
    const first = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(1);
    expect(first.searchParams.has("scope")).toBe(false);

    // A caller now explicitly requests scopes the stored client was never
    // registered with. Reusing it would silently send an authorize request
    // for a scope the provider never granted the client — must re-register.
    const second = await authorizeUrl(server.id, "read write");
    expect(dcrCallCount).toBe(2);
    expect(second.searchParams.get("client_id")).not.toBe(first.searchParams.get("client_id"));
    expect(second.searchParams.get("scope")).toBe("read write");

    // A further call requesting that SAME now-covered scope set reuses the
    // new client instead of registering yet again.
    const third = await authorizeUrl(server.id, "read write");
    expect(dcrCallCount).toBe(2);
    expect(third.searchParams.get("client_id")).toBe(second.searchParams.get("client_id"));
  });

  test("an invalid_client from a freshly-registered client's callback does not invalidate the different, connected client", async () => {
    const server = createMcpServer({
      name: "invalidate-wrong-target",
      transport: "http",
      url: MCP_URL,
      scope: "swarm",
    });

    // Connect once — client A.
    const first = await authorizeUrl(server.id);
    const stateA = first.searchParams.get("state")!;
    await dispatch(`/api/mcp-oauth/callback?state=${encodeURIComponent(stateA)}&code=auth-code`);
    expect(getMcpOAuthToken(server.id)?.status).toBe("connected");
    const clientA = getMcpOAuthToken(server.id)?.dcrClientId;
    expect(dcrCallCount).toBe(1);

    // A second flow requests a scope the connected client wasn't registered
    // with — forces a FRESH registration (client B) while client A stays
    // connected and untouched.
    const second = await authorizeUrl(server.id, "read write");
    expect(dcrCallCount).toBe(2);
    const stateB = second.searchParams.get("state")!;
    const clientB = second.searchParams.get("client_id");
    expect(clientB).not.toBe(clientA);

    // The provider rejects client B (the one actually used) at the token
    // endpoint.
    tokenShouldFail = "invalid_client";
    const callbackRes = await dispatch(
      `/api/mcp-oauth/callback?state=${encodeURIComponent(stateB)}&code=auth-code-2`,
    );
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.location).toContain("oauth=error");

    // Client A must still be connected with its ORIGINAL client_id — the bug
    // resolved the invalidation target via rawMcpToken(...)?.appId (the
    // connected app) regardless of which client actually failed, silently
    // corrupting it on the next /authorize call.
    tokenShouldFail = "";
    const afterFailure = getMcpOAuthToken(server.id);
    expect(afterFailure?.status).toBe("connected");
    expect(afterFailure?.dcrClientId).toBe(clientA);

    // Reusing client A's original (no-explicit-scope) conditions must still
    // work without a fresh registration — proving the connected app wasn't
    // flagged invalid by the unrelated client-B failure.
    const third = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(2);
    expect(third.searchParams.get("client_id")).toBe(clientA);
    expect(getMcpOAuthToken(server.id)?.dcrClientId).toBe(clientA);
  });

  test("authorize-endpoint rejection (query.error) invalidates the reused client instead of waiting for GC", async () => {
    const server = createMcpServer({
      name: "authorize-endpoint-reject",
      transport: "http",
      url: MCP_URL,
      scope: "swarm",
    });

    const first = await authorizeUrl(server.id);
    const stateA = first.searchParams.get("state")!;
    await dispatch(`/api/mcp-oauth/callback?state=${encodeURIComponent(stateA)}&code=auth-code`);
    expect(getMcpOAuthToken(server.id)?.status).toBe("connected");
    expect(dcrCallCount).toBe(1);

    // Re-authorize reuses the connected client (no new registration yet) —
    // but the provider rejects it at the AUTHORIZE endpoint, redirecting
    // back with an error instead of a code.
    const second = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(1);
    const stateB = second.searchParams.get("state")!;
    const rejectRes = await dispatch(
      `/api/mcp-oauth/callback?state=${encodeURIComponent(stateB)}&error=unauthorized_client`,
    );
    expect(rejectRes.status).toBe(302);
    expect(rejectRes.headers.location).toContain("error=unauthorized_client");

    // The next authorize call must register fresh — not keep offering the
    // client the provider just rejected at the authorize endpoint.
    const third = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(2);
    expect(third.searchParams.get("client_id")).not.toBe(first.searchParams.get("client_id"));
  });

  test("a legacy connector with no recorded registrationEndpoint reuses instead of re-registering forever", async () => {
    const server = createMcpServer({
      name: "legacy-null-registration-endpoint",
      transport: "http",
      url: MCP_URL,
      scope: "swarm",
    });

    const first = await authorizeUrl(server.id);
    const state = first.searchParams.get("state")!;
    await dispatch(`/api/mcp-oauth/callback?state=${encodeURIComponent(state)}&code=auth-code`);
    expect(getMcpOAuthToken(server.id)?.status).toBe("connected");
    const clientId = getMcpOAuthToken(server.id)?.dcrClientId;
    expect(dcrCallCount).toBe(1);

    // Simulate a pre-this-PR row: registrationEndpoint was never recorded.
    const db = getDb();
    const appRow = db
      .query(
        `SELECT a.id, a.metadata FROM oauth_apps a
         JOIN oauth_authorizations z ON z.appId = a.id
         WHERE a.mcpServerId = ?`,
      )
      .get(server.id) as { id: string; metadata: string };
    const metadata = JSON.parse(appRow.metadata);
    metadata.registrationEndpoint = null;
    db.query("UPDATE oauth_apps SET metadata = ? WHERE id = ?").run(
      JSON.stringify(metadata),
      appRow.id,
    );

    // An abandoned/retried flow must NOT force a fresh registration just
    // because the legacy row predates this field.
    const second = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(1);
    expect(second.searchParams.get("client_id")).toBe(clientId);
  });

  test("no explicit scopes + an empty registered scope set does not reuse with the full discovery scope set", async () => {
    const server = createMcpServer({
      name: "empty-registered-scope",
      transport: "http",
      url: MCP_URL,
      scope: "swarm",
    });

    const first = await authorizeUrl(server.id);
    const state = first.searchParams.get("state")!;
    await dispatch(`/api/mcp-oauth/callback?state=${encodeURIComponent(state)}&code=auth-code`);
    expect(getMcpOAuthToken(server.id)?.status).toBe("connected");
    const originalClientId = getMcpOAuthToken(server.id)?.dcrClientId;
    expect(dcrCallCount).toBe(1);

    // Simulate a client whose registered scope set was never recorded (e.g.
    // registered while the provider advertised none), while the provider now
    // advertises real scopes.
    const db = getDb();
    const appRow = db
      .query(
        `SELECT a.id FROM oauth_apps a JOIN oauth_authorizations z ON z.appId = a.id WHERE a.mcpServerId = ?`,
      )
      .get(server.id) as { id: string };
    db.query("UPDATE oauth_apps SET scopes = '[]' WHERE id = ?").run(appRow.id);
    asScopesSupported = ["read", "write"];

    // No explicit ?scopes= — must NOT silently reuse the unscoped client
    // with the AS's full advertised scope set. Must re-register properly
    // scoped instead.
    const second = await authorizeUrl(server.id);
    expect(dcrCallCount).toBe(2);
    expect(second.searchParams.get("client_id")).not.toBe(originalClientId);
    expect(second.searchParams.get("scope")).toBe("read write");
  });
});
