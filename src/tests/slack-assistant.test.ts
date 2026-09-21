import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getAgentWorkingOnThread,
  getLeadAgent,
  getMostRecentTaskInThread,
  getTaskById,
  initDb,
} from "../be/db";
import { createAssistant } from "../slack/assistant";
import { rewriteSlackMentions } from "../slack/enrich";
import { buildEffectiveText } from "../slack/inbound-files";

/** The single function Bolt's `Assistant` stores for the `message` event — not part of its public type. */
type AssistantUserMessageHandler = (args: Record<string, unknown>) => Promise<void>;

process.env.SLACK_RENDER_V2 = "false";

const TEST_DB_PATH = "./test-slack-assistant.sqlite";

let _leadAgent: Awaited<ReturnType<typeof createAgent>>;

beforeAll(async () => {
  initDb(TEST_DB_PATH);
  _leadAgent = await createAgent({ name: "AssistantLead", isLead: true, status: "idle" });
});

afterAll(() => {
  closeDb();
  try {
    unlinkSync(TEST_DB_PATH);
    unlinkSync(`${TEST_DB_PATH}-wal`);
    unlinkSync(`${TEST_DB_PATH}-shm`);
  } catch {
    // ignore
  }
});

describe("assistant userMessage routing — new thread (no working agent)", () => {
  test("getAgentWorkingOnThread returns null when no tasks exist for thread", async () => {
    const result = await getAgentWorkingOnThread("D_ASSISTANT", "6666666666.000001");
    expect(result).toBeNull();
  });

  test("getLeadAgent returns the lead agent for task assignment", async () => {
    const lead = await getLeadAgent();
    expect(lead).toBeDefined();
    expect(lead!.name).toBe("AssistantLead");
    expect(lead!.isLead).toBe(true);
  });

  test("creates task with slack context for new assistant thread message", async () => {
    const lead = (await getLeadAgent())!;
    const task = await createTaskExtended("What's the status of all agents?", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: "D_ASSISTANT",
      slackThreadTs: "7777777777.000001",
      slackUserId: "U_ASSISTANT",
    });

    expect(task).toBeDefined();
    expect(task.task).toBe("What's the status of all agents?");
    expect(task.source).toBe("slack");

    const fetched = await getTaskById(task.id);
    expect(fetched).toBeDefined();
    expect(fetched!.slackChannelId).toBe("D_ASSISTANT");
    expect(fetched!.slackThreadTs).toBe("7777777777.000001");
    expect(fetched!.slackUserId).toBe("U_ASSISTANT");
  });

  test("queues task without agentId when no lead is available", async () => {
    // Create a task without agentId (simulates no lead scenario)
    const task = await createTaskExtended("queued task, no lead", {
      source: "slack",
      slackChannelId: "D_NOHEAD",
      slackThreadTs: "8888888888.000001",
      slackUserId: "U_NOHEAD",
    });

    expect(task).toBeDefined();
    const fetched = await getTaskById(task.id);
    expect(fetched).toBeDefined();
    // Task should be created but unassigned (pending or similar status)
    expect(fetched!.agentId).toBeNull();
  });
});

describe("assistant userMessage routing — follow-up (working agent exists)", () => {
  test("getAgentWorkingOnThread returns the agent working on an active thread task", async () => {
    const worker = await createAgent({ name: "ThreadWorker", isLead: false, status: "idle" });
    await createTaskExtended("initial task in thread", {
      agentId: worker.id,
      source: "slack",
      slackChannelId: "D_FOLLOWUP",
      slackThreadTs: "9999999999.000001",
      slackUserId: "U_FOLLOWUP",
    });

    const result = await getAgentWorkingOnThread("D_FOLLOWUP", "9999999999.000001");
    expect(result).toBeDefined();
    expect(result!.name).toBe("ThreadWorker");
  });

  test("creates follow-up task assigned to the working agent", async () => {
    const workingAgent = await getAgentWorkingOnThread("D_FOLLOWUP", "9999999999.000001");
    expect(workingAgent).toBeDefined();

    const followUp = await createTaskExtended("follow-up message in assistant thread", {
      agentId: workingAgent!.id,
      source: "slack",
      slackChannelId: "D_FOLLOWUP",
      slackThreadTs: "9999999999.000001",
      slackUserId: "U_FOLLOWUP",
    });

    expect(followUp).toBeDefined();
    expect(followUp.agentId).toBe(workingAgent!.id);

    const fetched = await getTaskById(followUp.id);
    expect(fetched).toBeDefined();
    expect(fetched!.slackChannelId).toBe("D_FOLLOWUP");
    expect(fetched!.slackThreadTs).toBe("9999999999.000001");
  });
});

describe("assistant DM path self-mention rendering (Option 1 fix)", () => {
  const BOT_USER_ID = "U0ASK3PCZ4P";

  // Mirrors the exact call assistant.ts makes on the DM / Assistant path:
  // rewriteSlackMentions(buildEffectiveText(...), cachedBotUserId ?? undefined).
  test("bot's own mention renders '(that's you)' when the bot ID is cached", async () => {
    const cachedBotUserId: string | null = BOT_USER_ID;
    const rendered = await rewriteSlackMentions(
      buildEffectiveText(`<@${BOT_USER_ID}> what's the status?`),
      cachedBotUserId ?? undefined,
    );
    expect(rendered).toBe(`<@${BOT_USER_ID}> (that's you) what's the status?`);
    expect(rendered).not.toContain("(unknown user)");
  });

  test("falls back to today's behavior — no crash — when auth.test() has not cached a bot ID", async () => {
    const cachedBotUserId: string | null = null;
    const rendered = await rewriteSlackMentions(
      buildEffectiveText(`<@${BOT_USER_ID}> what's the status?`),
      cachedBotUserId ?? undefined,
    );
    expect(rendered).toBe(`<@${BOT_USER_ID}> (unknown user) what's the status?`);
  });
});

describe("assistant DM path self-mention rendering — production ingestion path", () => {
  // Drives `createAssistant()`'s real `userMessage` handler end-to-end (the
  // production DM path), rather than calling `rewriteSlackMentions` in
  // isolation. This is the regression test PR #108 review asked for: it must
  // fail if the fix at src/slack/assistant.ts (the `cachedBotUserId ??
  // undefined` argument to `rewriteSlackMentions`) is reverted.
  const BOT_USER_ID = "U0PRODBOT99";
  const OTHER_USER_ID = "U0PRODOTHR1";
  const CHANNEL_ID = "D_PROD_DM_SELF_MENTION";
  const THREAD_TS = "5551112223.000001";

  test("resolves the bot's own mention and leaves another user's mention correct", async () => {
    const assistant = createAssistant();
    const userMessage = (assistant as unknown as { userMessage: AssistantUserMessageHandler[] })
      .userMessage[0];

    const client = {
      auth: { test: async () => ({ user_id: BOT_USER_ID }) },
      reactions: { add: async () => ({}) },
      chat: { postMessage: async () => ({}) },
      users: { info: async () => ({ user: undefined }) },
    };

    const message = {
      channel: CHANNEL_ID,
      ts: THREAD_TS,
      thread_ts: THREAD_TS,
      text: `<@${BOT_USER_ID}> can you loop in <@${OTHER_USER_ID}> on this?`,
      user: "U_PROD_REQUESTER",
    };

    await userMessage({
      message,
      body: { event_id: "Ev_PROD_DM_SELF_MENTION_1" },
      say: async () => {},
      setStatus: async () => ({}),
      setTitle: async () => ({}),
      getThreadContext: async () => undefined,
      client,
    });

    const task = await getMostRecentTaskInThread(CHANNEL_ID, THREAD_TS);
    expect(task).toBeDefined();
    expect(task!.task).toBe(
      `<@${BOT_USER_ID}> (that's you) can you loop in <@${OTHER_USER_ID}> (unknown user) on this?`,
    );
  });
});

describe("assistant thread title truncation", () => {
  test("short messages stay as-is", () => {
    const text = "Check agent status";
    const title = text.length > 50 ? `${text.slice(0, 47)}...` : text;
    expect(title).toBe("Check agent status");
  });

  test("long messages get truncated to 50 chars", () => {
    const text =
      "This is a very long message that definitely exceeds the fifty character limit for thread titles";
    const title = text.length > 50 ? `${text.slice(0, 47)}...` : text;
    expect(title).toBe("This is a very long message that definitely exc...");
    expect(title.length).toBe(50);
  });
});
