import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, createTask, getDbClient, initDb } from "../be/db";
import { createEvent } from "../be/events";
import { registerReactionHandler } from "./reactions";

const TEST_DB_PATH = "./test-slack-reactions.sqlite";

type ReactionHandler = (args: {
  event: Record<string, unknown>;
  client: Record<string, unknown>;
}) => Promise<void>;

let reactionAddedHandler: ReactionHandler | undefined;
let reactionRemovedHandler: ReactionHandler | undefined;
let taskId: string;

const fakeClient = {
  conversations: {
    history: async () => ({ messages: [], ok: true }),
  },
};

beforeAll(async () => {
  try {
    await unlink(TEST_DB_PATH);
  } catch {}
  initDb(TEST_DB_PATH);

  const agent = await createAgent({
    name: "Reactions Test Agent",
    isLead: false,
    status: "idle",
    capabilities: [],
  });
  const task = await createTask(agent.id, "seed task for skills ledger test");
  taskId = task.id;
  await getDbClient().run("UPDATE agent_tasks SET contextKey = ? WHERE id = ?", [
    "task:slack:C_TEST:1111.2222",
    taskId,
  ]);

  await createEvent({
    category: "skill",
    event: "skill.invoke",
    source: "worker",
    agentId: agent.id,
    taskId,
    data: { skillName: "test-skill" },
  });

  registerReactionHandler({
    event: (eventType: string, handler: ReactionHandler) => {
      if (eventType === "reaction_added") reactionAddedHandler = handler;
      if (eventType === "reaction_removed") reactionRemovedHandler = handler;
    },
  } as never);
});

afterAll(async () => {
  closeDb();
  try {
    await unlink(TEST_DB_PATH);
    await unlink(`${TEST_DB_PATH}-wal`);
    await unlink(`${TEST_DB_PATH}-shm`);
  } catch {}
});

describe("registerReactionHandler", () => {
  test("registers both reaction_added and reaction_removed", () => {
    expect(reactionAddedHandler).toBeDefined();
    expect(reactionRemovedHandler).toBeDefined();
  });

  test("a +1 reaction writes a skill.outcome row, and removing it writes a second row", async () => {
    await reactionAddedHandler!({
      event: {
        type: "reaction_added",
        user: "U_TESTER",
        reaction: "+1",
        item: { type: "message", channel: "C_TEST", ts: "1111.2222" },
      },
      client: fakeClient,
    });

    await reactionRemovedHandler!({
      event: {
        type: "reaction_removed",
        user: "U_TESTER",
        reaction: "+1",
        item: { type: "message", channel: "C_TEST", ts: "1111.2222" },
      },
      client: fakeClient,
    });

    // `id` is a random UUID (not sequential), so order by rowid — SQLite's
    // implicit insertion-order column — for a deterministic assertion here.
    // The task's literal acceptance-check SQL (`ORDER BY id`) is run and
    // reported separately; UUID ordering makes it non-deterministic in general.
    const rows = await getDbClient().query<{ outcome: string; removed: number }>(
      `SELECT json_extract(data, '$.outcome') AS outcome, json_extract(data, '$.removed') AS removed
       FROM events WHERE event = 'skill.outcome' ORDER BY rowid`,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ outcome: "pass", removed: 0 });
    expect(rows[1]).toEqual({ outcome: "pass", removed: 1 });
  });

  test("an unmapped reaction writes no row", async () => {
    const before = (
      await getDbClient().query<{ id: string }>(
        "SELECT id FROM events WHERE event = 'skill.outcome'",
      )
    ).length;

    await reactionAddedHandler!({
      event: {
        type: "reaction_added",
        user: "U_TESTER",
        reaction: "tada",
        item: { type: "message", channel: "C_TEST", ts: "1111.2222" },
      },
      client: fakeClient,
    });

    const after = (
      await getDbClient().query<{ id: string }>(
        "SELECT id FROM events WHERE event = 'skill.outcome'",
      )
    ).length;
    expect(after).toBe(before);
  });

  test("skin-tone suffix is stripped before mapping", async () => {
    await reactionAddedHandler!({
      event: {
        type: "reaction_added",
        user: "U_TESTER",
        reaction: "-1::skin-tone-3",
        item: { type: "message", channel: "C_TEST", ts: "1111.2222" },
      },
      client: fakeClient,
    });

    const rows = await getDbClient().query<{ outcome: string; family: string; reaction: string }>(
      `SELECT json_extract(data, '$.outcome') AS outcome,
              json_extract(data, '$.family') AS family,
              json_extract(data, '$.reaction') AS reaction
       FROM events WHERE event = 'skill.outcome' ORDER BY rowid DESC LIMIT 1`,
    );
    expect(rows[0]).toEqual({ outcome: "fail", family: "feedback", reaction: "-1" });
  });

  test("a reaction with no resolvable task writes no row", async () => {
    const before = (
      await getDbClient().query<{ id: string }>(
        "SELECT id FROM events WHERE event = 'skill.outcome'",
      )
    ).length;

    await reactionAddedHandler!({
      event: {
        type: "reaction_added",
        user: "U_TESTER",
        reaction: "+1",
        item: { type: "message", channel: "C_UNKNOWN", ts: "9999.9999" },
      },
      client: fakeClient,
    });

    const after = (
      await getDbClient().query<{ id: string }>(
        "SELECT id FROM events WHERE event = 'skill.outcome'",
      )
    ).length;
    expect(after).toBe(before);
  });
});
