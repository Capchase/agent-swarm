import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDb, createAgent, getSlackTasksInThread, initDb } from "../be/db";
import { resetExternalChannelStateForTesting } from "../slack/external-channel";
import { registerMessageHandler, resetSlackHandlerCachesForTesting } from "../slack/handlers";

const TEST_DB_PATH = "./test-slack-external-channel-guard.sqlite";
const BOT_USER_ID = "U_EXT_GUARD_BOT";

const previousEnv = {
  SLACK_BLOCK_EXTERNAL_CHANNELS: process.env.SLACK_BLOCK_EXTERNAL_CHANNELS,
  SLACK_RENDER_V2: process.env.SLACK_RENDER_V2,
  ADDITIVE_SLACK: process.env.ADDITIVE_SLACK,
  SLACK_ALERTS_CHANNEL: process.env.SLACK_ALERTS_CHANNEL,
};

type Handler = (args: Record<string, unknown>) => Promise<void>;
const handlers = new Map<string, Handler>();

let channelInfo: Record<string, unknown> = {};
let infoCalls = 0;
let leaveCalls: string[] = [];
let alertPosts: string[] = [];

const client = {
  auth: { test: async () => ({ user_id: BOT_USER_ID, bot_id: "B_EXT_GUARD_BOT" }) },
  conversations: {
    info: async () => {
      infoCalls++;
      return { ok: true, channel: channelInfo };
    },
    leave: async ({ channel }: { channel: string }) => {
      leaveCalls.push(channel);
      return { ok: true };
    },
    replies: async () => ({ ok: true, messages: [] }),
  },
  chat: {
    postMessage: async ({ text }: { text: string }) => {
      alertPosts.push(text);
      return { ok: true, ts: "1.1" };
    },
  },
  reactions: { add: async () => ({ ok: true }) },
  users: { info: async () => ({ ok: true, user: { profile: {} } }) },
};

let counter = 0;
async function sendMention(channel: string, envelopeExt: boolean) {
  counter++;
  const ts = `17000.${String(counter).padStart(4, "0")}`;
  await handlers.get("message")!({
    event: { channel, ts, text: `<@${BOT_USER_ID}> please help`, user: "U_EXT_GUARD_HUMAN" },
    body: { event_id: `evt_ext_guard_${counter}`, is_ext_shared_channel: envelopeExt },
    client,
    say: async () => ({ ok: true, ts: "1.2" }),
  });
  return getSlackTasksInThread(channel, ts);
}

beforeAll(async () => {
  initDb(TEST_DB_PATH);
  process.env.SLACK_RENDER_V2 = "false";
  process.env.ADDITIVE_SLACK = "false";
  process.env.SLACK_ALERTS_CHANNEL = "C_ALERTS";
  await createAgent({ name: "ext-guard-lead", isLead: true, status: "idle", capabilities: [] });
  registerMessageHandler({
    event: (type: string, handler: Handler) => {
      handlers.set(type, handler);
    },
  } as never);
});

afterAll(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {
      // ignore
    }
  }
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  resetExternalChannelStateForTesting();
  resetSlackHandlerCachesForTesting();
  channelInfo = { is_ext_shared: false, is_pending_ext_shared: false };
  infoCalls = 0;
  leaveCalls = [];
  alertPosts = [];
});

describe("inbound guard (message handler)", () => {
  test("flag true + envelope is_ext_shared_channel: 0 tasks", async () => {
    process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = "true";
    expect(await sendMention("C_EXT_ENVELOPE", true)).toHaveLength(0);
  });

  test("flag false + envelope is_ext_shared_channel: 1 task (current behavior)", async () => {
    process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = "false";
    expect(await sendMention("C_EXT_FLAG_OFF", true)).toHaveLength(1);
  });

  test("flag true + envelope false + is_pending_ext_shared: 0 tasks", async () => {
    process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = "true";
    channelInfo = { is_pending_ext_shared: true };
    expect(await sendMention("C_EXT_PENDING", false)).toHaveLength(0);
    expect(infoCalls).toBe(1);
  });

  test("flag true + internal channel: 1 task", async () => {
    process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = "true";
    expect(await sendMention("C_INTERNAL", false)).toHaveLength(1);
  });
});

describe("join and share events", () => {
  test("bot joins an external channel: 1 leave and 1 alert", async () => {
    process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = "true";
    channelInfo = { is_ext_shared: true };
    await handlers.get("member_joined_channel")!({
      event: { user: BOT_USER_ID, channel: "C_JOIN_EXT" },
      client,
    });
    expect(leaveCalls).toEqual(["C_JOIN_EXT"]);
    expect(alertPosts).toHaveLength(1);
    expect(alertPosts[0]).toContain("Trigger: joined");
  });

  test("a human joins an external channel: 0 Slack calls", async () => {
    process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = "true";
    channelInfo = { is_ext_shared: true };
    await handlers.get("member_joined_channel")!({
      event: { user: "U_SOMEONE_ELSE", channel: "C_JOIN_HUMAN" },
      client,
    });
    expect(infoCalls).toBe(0);
    expect(leaveCalls).toHaveLength(0);
    expect(alertPosts).toHaveLength(0);
  });

  test("bot joins an internal channel: 0 leave calls", async () => {
    process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = "true";
    await handlers.get("member_joined_channel")!({
      event: { user: BOT_USER_ID, channel: "C_JOIN_INT" },
      client,
    });
    expect(leaveCalls).toHaveLength(0);
  });

  test("channel_shared on a cached internal channel: fresh info call and 1 leave", async () => {
    process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = "true";
    await handlers.get("member_joined_channel")!({
      event: { user: BOT_USER_ID, channel: "C_SHARED" },
      client,
    });
    expect(infoCalls).toBe(1);
    channelInfo = { is_ext_shared: true };
    await handlers.get("channel_shared")!({
      event: { channel: "C_SHARED", connected_team_id: "T0OTHER" },
      client,
    });
    expect(infoCalls).toBe(2);
    expect(leaveCalls).toEqual(["C_SHARED"]);
    expect(alertPosts[0]).toContain("Trigger: shared");
  });

  test("channel_unshared invalidates the cache only", async () => {
    process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = "true";
    await handlers.get("member_joined_channel")!({
      event: { user: BOT_USER_ID, channel: "C_UNSHARED" },
      client,
    });
    await handlers.get("channel_unshared")!({ event: { channel: "C_UNSHARED" }, client });
    expect(infoCalls).toBe(1);
    expect(leaveCalls).toHaveLength(0);
    await handlers.get("member_joined_channel")!({
      event: { user: BOT_USER_ID, channel: "C_UNSHARED" },
      client,
    });
    expect(infoCalls).toBe(2);
  });

  test("flag false: 0 Slack calls from any event", async () => {
    process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = "false";
    channelInfo = { is_ext_shared: true };
    let authCalls = 0;
    const countingClient = {
      ...client,
      auth: {
        test: async () => {
          authCalls++;
          return { user_id: BOT_USER_ID };
        },
      },
    };
    await handlers.get("member_joined_channel")!({
      event: { user: BOT_USER_ID, channel: "C_OFF" },
      client: countingClient,
    });
    await handlers.get("channel_shared")!({ event: { channel: "C_OFF" }, client: countingClient });
    await handlers.get("channel_unshared")!({
      event: { channel: "C_OFF" },
      client: countingClient,
    });
    expect(authCalls + infoCalls + leaveCalls.length + alertPosts.length).toBe(0);
  });
});
