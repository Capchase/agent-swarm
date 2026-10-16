import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const postMessage = mock(async (_input: Record<string, unknown>) => ({ ts: "2.2" }));
const slackModule = await import("../slack/app");
mock.module("../slack/app", () => ({
  ...slackModule,
  getSlackApp: () => ({ client: { chat: { postMessage } } }),
}));

import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getApprovalRequestById,
  initDb,
  startTask,
} from "../be/db";
import { linkIdentity } from "../be/users";
import { registerRequestHumanInputTool } from "../tools/request-human-input";

type Tool = {
  inputSchema: { safeParse: (args: unknown) => { success: boolean } };
  handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
};
const keys = ["APPROVAL_REQUEST_DEFAULT_TIMEOUT_SECONDS", "APPROVAL_DEFAULT_SLACK_TARGET"];
const original = keys.map((key) => process.env[key]);
let tool: Tool;
let agentId: string;
let leadId: string;
let ownerId: string;

beforeAll(async () => {
  initDb(":memory:");
  agentId = (await createAgent({ name: "Approval requester", status: "idle", capabilities: [] }))
    .id;
  leadId = (
    await createAgent({ name: "Approval lead", status: "idle", capabilities: [], isLead: true })
  ).id;
  ownerId = (await createUser({ name: "Local approval fixture", email: "owner@example.test" })).id;
  await linkIdentity(ownerId, "slack", "UOWNER", { kind: "system", id: "test" });
  const server = new McpServer({ name: "request-human-input-test", version: "1" });
  registerRequestHumanInputTool(server);
  tool = (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools[
    "request-human-input"
  ]!;
});
beforeEach(() => {
  for (const key of keys) delete process.env[key];
  postMessage.mockReset();
  postMessage.mockImplementation(async () => ({ ts: "2.2" }));
});
afterEach(() => {
  keys.forEach((key, index) => {
    if (original[index] === undefined) delete process.env[key];
    else process.env[key] = original[index];
  });
});
afterAll(() => closeDb());

async function request(
  overrides: Record<string, unknown> = {},
  thread = true,
  header = true,
  callerId = agentId,
  success = true,
) {
  const source = await createTaskExtended("Needs a decision", {
    agentId: callerId,
    ...(thread ? { slackChannelId: "C1", slackThreadTs: "1.1", slackUserId: "U1" } : {}),
  });
  await startTask(source.id);
  const result = await tool.handler(
    {
      title: "Deploy",
      questions: [{ id: "q", type: "approval", label: "Approve?" }],
      ...overrides,
    },
    {
      sessionId: crypto.randomUUID(),
      requestInfo: {
        headers: { "x-agent-id": callerId, ...(header ? { "x-source-task-id": source.id } : {}) },
      },
    },
  );
  const data = result.structuredContent as {
    success: boolean;
    message: string;
    requestId: string;
    notifiedTarget?: string;
    timeoutSeconds?: number;
  };
  expect(data.success).toBe(success);
  if (!success) return { data, stored: null! };
  const stored = await getApprovalRequestById(data.requestId);
  expect(stored).not.toBeNull();
  return { data, stored: stored! };
}

describe("request-human-input owner, notice and timeout", () => {
  test("default: notice in the source task thread with a mention, 24 h timeout", async () => {
    const now = Date.now();
    const { data, stored } = await request();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0]![0]).toMatchObject({ channel: "C1", thread_ts: "1.1" });
    expect(postMessage.mock.calls[0]![0].text).toContain("<@U1>");
    expect(stored.approvers).toEqual({ policy: "any" });
    expect(stored.notificationChannels).toEqual([
      { channel: "slack", target: "C1", threadTs: "1.1", messageTs: "2.2" },
    ]);
    expect(Date.parse(stored.expiresAt!) - now).toBeGreaterThanOrEqual(86_400_000);
    expect(Date.parse(stored.expiresAt!) - now).toBeLessThan(86_402_000);
    expect(data.timeoutSeconds).toBe(86400);
    expect(data.notifiedTarget).toBe("C1");
  });
  test.each([
    "swarm id",
    "email",
    "Slack id",
  ])("resolves approver by %s and stores its swarm user id", async (kind) => {
    const entry =
      kind === "swarm id" ? ownerId : kind === "email" ? "owner@example.test" : "UOWNER";
    const { stored } = await request({ approvers: [entry] });
    expect(stored.approvers).toEqual({ policy: "any", users: [ownerId] });
  });
  test("unknown approvers name every unresolved entry and create no request or notice", async () => {
    const { data } = await request(
      { approvers: [ownerId, "UMISSING", "unknown@example.test"] },
      true,
      true,
      agentId,
      false,
    );
    expect(data.message).toContain("UMISSING");
    expect(data.message).toContain("unknown@example.test");
    expect(data.message).not.toContain(ownerId);
    expect(data.requestId).toBeUndefined();
    expect(postMessage).not.toHaveBeenCalled();
  });
  test("scrubs secrets from the approval title and question label before Slack egress", async () => {
    const titleSecret = `ghp_${"aB3".repeat(12)}`;
    const labelSecret = `ghp_${"cD4".repeat(12)}`;
    await request({
      title: `Deploy with ${titleSecret}`,
      questions: [{ id: "q", type: "approval", label: `Approve using ${labelSecret}?` }],
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
    const payload = postMessage.mock.calls[0]![0];
    expect(JSON.stringify(payload)).not.toContain(titleSecret);
    expect(JSON.stringify(payload)).not.toContain(labelSecret);
    expect(payload.text).toContain("Deploy with [REDACTED:github_token]");
    expect(JSON.stringify(payload.blocks)).toContain("Deploy with [REDACTED:github_token]");
    expect(JSON.stringify(payload.blocks)).toContain("Approve using [REDACTED:github_token]?");
  });
  test("non-lead notify is denied before creating or posting an approval", async () => {
    const { data } = await request({ notify: "CRANDOM" }, true, true, agentId, false);
    expect(data.message).toContain("lead privileges");
    expect(data.requestId).toBeUndefined();
    expect(postMessage).not.toHaveBeenCalled();
  });
  test.each([
    "#ops",
    "channel",
    "C-lower",
    "",
    "U1 ",
  ])("invalid notify %s fails input validation", (notify) => {
    expect(
      tool.inputSchema.safeParse({
        title: "Deploy",
        questions: [{ id: "q", type: "approval", label: "Approve?" }],
        notify,
      }).success,
    ).toBe(false);
  });
  test("caller notify wins over the thread", async () => {
    await request({ notify: "U9" }, true, true, leadId);
    expect(postMessage.mock.calls[0]![0].channel).toBe("U9");
    expect(postMessage.mock.calls[0]![0].thread_ts).toBeUndefined();
    expect(postMessage.mock.calls[0]![0].text).not.toContain("<@U1>");
  });
  test("no thread: falls back to APPROVAL_DEFAULT_SLACK_TARGET", async () => {
    process.env.APPROVAL_DEFAULT_SLACK_TARGET = "COPS";
    await request({}, false);
    expect(postMessage.mock.calls[0]![0].channel).toBe("COPS");
  });
  test("no thread and no config: no notice, result says so", async () => {
    const { data } = await request({}, false);
    expect(postMessage).not.toHaveBeenCalled();
    expect(data.message).toContain("No Slack notice was sent");
    expect(data.notifiedTarget).toBeUndefined();
  });
  test("config 0 keeps the old no-timeout behavior", async () => {
    process.env.APPROVAL_REQUEST_DEFAULT_TIMEOUT_SECONDS = "0";
    const { data, stored } = await request();
    expect(stored.expiresAt).toBeNull();
    expect(data.timeoutSeconds).toBeUndefined();
  });
  test("a Slack failure does not fail the tool", async () => {
    postMessage.mockImplementation(async () => {
      throw new Error("Slack unavailable");
    });
    const { data, stored } = await request();
    expect(stored.status).toBe("pending");
    expect(data.notifiedTarget).toBeUndefined();
    expect(data.message).toContain("No Slack notice was sent");
  });
  test("caller timeout wins over disabled default", async () => {
    process.env.APPROVAL_REQUEST_DEFAULT_TIMEOUT_SECONDS = "0";
    const now = Date.now();
    const { data, stored } = await request({ timeoutSeconds: 90 });
    expect(data.timeoutSeconds).toBe(90);
    expect(Date.parse(stored.expiresAt!) - now).toBeGreaterThanOrEqual(90_000);
    expect(Date.parse(stored.expiresAt!) - now).toBeLessThan(92_000);
  });
  test("missing source header uses the agent's current task thread", async () => {
    await request({}, true, false);
    expect(postMessage.mock.calls[0]![0]).toMatchObject({ channel: "C1", thread_ts: "1.1" });
  });
});
