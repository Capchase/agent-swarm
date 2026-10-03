import { describe, expect, test } from "bun:test";
import { ApiError, createClient } from "../commands/attach/api";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function fake(status: number, payload: unknown) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: init.body as string | undefined,
    });
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
  return { calls, client: createClient({ apiUrl: "http://h/", token: "aswt_abc", fetchImpl }) };
}

describe("attach api client", () => {
  test("paths, methods, auth header", async () => {
    const { calls, client } = fake(200, { agents: [], tasks: [], logs: [], messages: [] });
    await client.whoami();
    await client.listAgents();
    await client.listTasks({ agentId: "a1", status: "in_progress", limit: 1 });
    await client.getTask("t1");
    await client.sessionLogs("t1");
    await client.steeringMessages("t1");
    await client.steer("t1", {
      message: "m",
      mode: "queue",
      onUnsupported: "degrade",
      source: "api",
    });
    await client.cancel("t1");
    await client.createTask({
      task: "x",
      agentId: "a1",
      routingReason: "human_pinned",
      source: "api",
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET http://h/api/whoami",
      "GET http://h/api/agents?fields=slim",
      "GET http://h/api/tasks?agentId=a1&status=in_progress&limit=1&fields=slim",
      "GET http://h/api/tasks/t1?logsLimit=1",
      "GET http://h/api/tasks/t1/session-logs?limit=1000",
      "GET http://h/api/tasks/t1/steering-messages",
      "POST http://h/api/tasks/t1/steer",
      "POST http://h/api/tasks/t1/cancel",
      "POST http://h/api/tasks",
    ]);
    for (const c of calls) expect(c.headers.Authorization).toBe("Bearer aswt_abc");
  });
  test("422 throws ApiError", async () => {
    const { client } = fake(422, { error: "unsupported" });
    const err = await client
      .steer("t", { message: "m", mode: "steer", onUnsupported: "fail", source: "api" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
  });
  test("401 mentions attach setup", async () => {
    const { client } = fake(401, { error: "no" });
    const err = await client.whoami().catch((e) => e);
    expect(err.message).toContain("attach setup");
  });
});
