/**
 * Production-path regression tests for the assistant-surface co-mention guard.
 *
 * These tests invoke the REAL production handlers (createAssistant().userMessage and
 * the registerMessageHandler callback) to verify that task creation is suppressed
 * when a Slack message @-mentions a different agent (e.g. Devin) but NOT our bot.
 *
 * Mutation resistance: removing the guard from src/slack/assistant.ts or
 * src/slack/handlers.ts causes the co-mention message to reach
 * createTaskWithSiblingAwareness, which fails the `not.toHaveBeenCalled()` assertions.
 *
 * Complements slack-assistant-comention.test.ts (pure helper-function unit tests).
 * Regression for task 4ae1f3b5 — "<@U0831BS93V1> Are you here?" spawned an unwanted task.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Snapshot real modules BEFORE mocking.
//
// Bun mutates live module-namespace bindings when mock.module() runs, so a
// plain `await import()` captured before the call still returns the mock after
// mock.module() executes.  Spreading the namespace into a plain object copies
// the function references at snapshot-time, freezing the real exports.
//
// These snapshots are used in afterAll() to restore the global module registry
// so that subsequent test files in the same bun process get the real modules.
// ---------------------------------------------------------------------------
const _realSiblingAwareness = { ...(await import("../tasks/sibling-awareness")) };
const _realDb = { ...(await import("../be/db")) };
const _realEnrich = { ...(await import("../slack/enrich")) };
const _realEventDedup = { ...(await import("../slack/event-dedup")) };
const _realThreadBuffer = { ...(await import("../slack/thread-buffer")) };
const _realResolver = { ...(await import("../prompts/resolver")) };
const _realContextKey = { ...(await import("../tasks/context-key")) };
const _realWatcher = { ...(await import("../slack/watcher")) };

// ---------------------------------------------------------------------------
// Module mocks — Bun hoists these before all imports.
// Stub every side-effectful dependency so the real production handlers
// can run in isolation without a database or live Slack connection.
// ---------------------------------------------------------------------------

const createTaskMock = mock(() => ({ id: "mock-task-id-prod-path" }));

mock.module("../tasks/sibling-awareness", () => ({
  createTaskWithSiblingAwareness: createTaskMock,
}));

mock.module("../be/db", () => ({
  getAgentWorkingOnThread: mock(() => null),
  getLeadAgent: mock(() => ({ id: "lead-prod-test-1", name: "TestLead", isLead: true })),
  getMostRecentTaskInThread: mock(() => null),
  getAgentById: mock(() => null),
  getAllAgents: mock(() => []),
  getTasksByAgentId: mock(() => []),
}));

mock.module("../slack/enrich", () => ({
  resolveSlackUserId: mock(async () => undefined),
  enrichSlackUserEmail: mock(async () => null),
}));

mock.module("../slack/event-dedup", () => ({
  wasEventSeen: mock(() => false),
}));

mock.module("../slack/thread-buffer", () => ({
  bufferThreadMessage: mock(() => {}),
  getBufferMessageCount: mock(() => 0),
  instantFlush: mock(async () => {}),
}));

mock.module("../prompts/resolver", () => ({
  resolveTemplate: mock(() => ({ text: "offline" })),
  configureDbResolver: mock(() => {}),
  configureHttpResolver: mock(() => {}),
  resetDbResolver: mock(() => {}),
  resetHttpResolver: mock(() => {}),
  isHttpResolverConfigured: mock(() => false),
}));

mock.module("../tasks/context-key", () => ({
  slackContextKey: mock(() => "test-ctx-key"),
}));

mock.module("../slack/watcher", () => ({
  registerTreeMessage: mock(() => {}),
}));

import { createAssistant } from "../slack/assistant";
import { registerMessageHandler } from "../slack/handlers";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const BOT_USER_ID = "U_BOT_PROD_TEST";
const DEVIN_USER_ID = "U0831BS93V1"; // the other agent from the original regression

// Mock Slack WebClient — auth.test() returns our bot's user ID so the
// module-level cachedBotUserId gets populated on the first handler invocation.
const mockClient = {
  auth: {
    test: async () => ({ user_id: BOT_USER_ID, bot_id: "B_BOT_PROD_TEST" }),
  },
  conversations: {
    // Needed only if getThreadContext is reached (thread_ts set); returning
    // empty messages is safe for the paths exercised here.
    replies: async () => ({ messages: [], ok: true }),
  },
};

// ---------------------------------------------------------------------------
// Production-path: assistant.ts — createAssistant().userMessage
// ---------------------------------------------------------------------------

describe("assistant.ts — userMessage production-path co-mention guard", () => {
  // Access the registered middleware function directly.
  // Bolt stores handlers as an array; [0] is the callback passed to the config.
  let userMessageHandler: (args: Record<string, unknown>) => Promise<void>;

  beforeAll(() => {
    userMessageHandler = (createAssistant() as any).userMessage[0] as typeof userMessageHandler;
  });

  beforeEach(() => {
    createTaskMock.mockClear();
  });

  test("does NOT spawn a task when message @-mentions another agent but not our bot", async () => {
    await userMessageHandler({
      message: {
        channel: "D_ASSISTANT_PROD_TEST",
        ts: "1000000001.000001",
        text: `<@${DEVIN_USER_ID}> Are you here?`,
        user: "U_HUMAN_ASST_001",
      },
      body: { event_id: "evt_prod_asst_comention_001" },
      say: mock(async () => {}),
      setStatus: mock(async () => {}),
      setTitle: mock(async () => {}),
      getThreadContext: mock(async () => ({})),
      client: mockClient,
    });

    expect(createTaskMock).not.toHaveBeenCalled();
  });

  test("DOES spawn a task for a plain DM with no @-mentions (baseline)", async () => {
    await userMessageHandler({
      message: {
        channel: "D_ASSISTANT_PROD_TEST",
        ts: "1000000001.000002",
        text: "What is the current status of all agents?",
        user: "U_HUMAN_ASST_001",
      },
      body: { event_id: "evt_prod_asst_plain_001" },
      say: mock(async () => {}),
      setStatus: mock(async () => {}),
      setTitle: mock(async () => {}),
      getThreadContext: mock(async () => ({})),
      client: mockClient,
    });

    expect(createTaskMock).toHaveBeenCalledTimes(1);
  });

  test("does NOT spawn a task when message @-mentions a human user but not our bot", async () => {
    await userMessageHandler({
      message: {
        channel: "D_ASSISTANT_PROD_TEST",
        ts: "1000000001.000003",
        text: "<@U037TJB7VHQ> what do you think?",
        user: "U_HUMAN_ASST_001",
      },
      body: { event_id: "evt_prod_asst_comention_002" },
      say: mock(async () => {}),
      setStatus: mock(async () => {}),
      setTitle: mock(async () => {}),
      getThreadContext: mock(async () => ({})),
      client: mockClient,
    });

    expect(createTaskMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Production-path: handlers.ts — registerMessageHandler, assistant_thread fallback
//
// File-share messages in DM assistant threads bypass the Assistant handler and
// land in the generic message handler. The isImplicitMention logic in
// registerMessageHandler must suppress task creation when assistant_thread is set
// AND the message @-mentions a different user (not our bot).
// ---------------------------------------------------------------------------

describe("registerMessageHandler — assistant_thread co-mention guard (production-path)", () => {
  type MessageEventArg = {
    channel: string;
    ts: string;
    text?: string;
    user?: string;
    subtype?: string;
    bot_id?: string;
    assistant_thread?: Record<string, unknown>;
    thread_ts?: string;
  };

  type HandlerArgs = {
    event: MessageEventArg;
    body: Record<string, unknown>;
    client: typeof mockClient;
    say: (args: unknown) => Promise<void>;
  };

  let capturedHandler: ((args: HandlerArgs) => Promise<void>) | null = null;

  beforeAll(() => {
    const mockApp = {
      event: (eventType: string, handler: (args: HandlerArgs) => Promise<void>) => {
        // registerMessageHandler calls app.event("message", ...) and then
        // app.event("app_mention", ...). Capture only the message handler.
        if (eventType === "message") {
          capturedHandler = handler;
        }
      },
    };
    registerMessageHandler(mockApp as any);
  });

  beforeEach(() => {
    createTaskMock.mockClear();
  });

  test("does NOT spawn a task when assistant_thread message @-mentions another agent", async () => {
    expect(capturedHandler).not.toBeNull();

    await capturedHandler!({
      event: {
        channel: "D_HANDLER_PROD_TEST",
        ts: "2000000001.000001",
        text: `<@${DEVIN_USER_ID}> Are you here?`,
        user: "U_HUMAN_HDLR_001",
        assistant_thread: { channel_id: "D_HANDLER_PROD_TEST" },
      },
      body: { event_id: "evt_prod_hdlr_comention_001" },
      client: mockClient,
      say: mock(async () => {}),
    });

    expect(createTaskMock).not.toHaveBeenCalled();
  });

  test("DOES spawn a task for assistant_thread plain message with no @-mentions (baseline)", async () => {
    expect(capturedHandler).not.toBeNull();

    await capturedHandler!({
      event: {
        channel: "D_HANDLER_PROD_TEST",
        ts: "2000000001.000002",
        text: "What is the current status of all agents?",
        user: "U_HUMAN_HDLR_001",
        assistant_thread: { channel_id: "D_HANDLER_PROD_TEST" },
      },
      body: { event_id: "evt_prod_hdlr_plain_001" },
      client: mockClient,
      say: mock(async () => {}),
    });

    expect(createTaskMock).toHaveBeenCalledTimes(1);
  });

  test("does NOT spawn a task when assistant_thread message @-mentions a human (not our bot)", async () => {
    expect(capturedHandler).not.toBeNull();

    await capturedHandler!({
      event: {
        channel: "D_HANDLER_PROD_TEST",
        ts: "2000000001.000003",
        text: "<@U037TJB7VHQ> what do you think?",
        user: "U_HUMAN_HDLR_001",
        assistant_thread: { channel_id: "D_HANDLER_PROD_TEST" },
      },
      body: { event_id: "evt_prod_hdlr_comention_002" },
      client: mockClient,
      say: mock(async () => {}),
    });

    expect(createTaskMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Restore the real module implementations after all tests in this file.
//
// mock.module() overrides persist for the entire bun process; without this
// cleanup every subsequent test file that imports ../be/db, ../prompts/resolver,
// etc. would receive the stub implementations above instead of the real ones.
// ---------------------------------------------------------------------------
afterAll(() => {
  mock.module("../tasks/sibling-awareness", () => _realSiblingAwareness);
  mock.module("../be/db", () => _realDb);
  mock.module("../slack/enrich", () => _realEnrich);
  mock.module("../slack/event-dedup", () => _realEventDedup);
  mock.module("../slack/thread-buffer", () => _realThreadBuffer);
  mock.module("../prompts/resolver", () => _realResolver);
  mock.module("../tasks/context-key", () => _realContextKey);
  mock.module("../slack/watcher", () => _realWatcher);
});
