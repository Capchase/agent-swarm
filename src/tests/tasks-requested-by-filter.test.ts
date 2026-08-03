import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getAllTasks,
  getTasksCount,
  initDb,
} from "../be/db";

const TEST_DB_PATH = "./test-tasks-requested-by-filter.sqlite";

let agentId: string;
let userAId: string;
let userBId: string;

describe("getAllTasks / getTasksCount requestedByUserId filter", () => {
  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    agentId = createAgent({
      id: "requested-by-filter-agent",
      name: "Requested By Filter Agent",
      isLead: false,
      status: "idle",
    }).id;
    userAId = createUser({ name: "User A", email: "user-a@example.com" }).id;
    userBId = createUser({ name: "User B", email: "user-b@example.com" }).id;
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  test("requestedByUserId=<id> filters to that requester's tasks only, list and count agree", () => {
    const taskA = createTaskExtended("task for user A", { agentId, requestedByUserId: userAId });
    const taskB = createTaskExtended("task for user B", { agentId, requestedByUserId: userBId });
    const taskUnattributed = createTaskExtended("task with no requester", { agentId });

    const listForA = getAllTasks({ requestedByUserId: userAId, includeHeartbeat: true });
    const ids = listForA.map((t) => t.id);
    expect(ids).toContain(taskA.id);
    expect(ids).not.toContain(taskB.id);
    expect(ids).not.toContain(taskUnattributed.id);

    expect(getTasksCount({ requestedByUserId: userAId, includeHeartbeat: true })).toBe(
      listForA.length,
    );
  });

  test("requestedByUserIdIsNull returns only unattributed rows, list and count agree", () => {
    const taskA = createTaskExtended("second task for user A", {
      agentId,
      requestedByUserId: userAId,
    });
    const taskUnattributed = createTaskExtended("second task with no requester", { agentId });

    const nullList = getAllTasks({ requestedByUserIdIsNull: true, includeHeartbeat: true });
    const ids = nullList.map((t) => t.id);
    expect(ids).toContain(taskUnattributed.id);
    expect(ids).not.toContain(taskA.id);
    expect(nullList.every((t) => !t.requestedByUserId)).toBe(true);

    expect(getTasksCount({ requestedByUserIdIsNull: true, includeHeartbeat: true })).toBe(
      nullList.length,
    );
  });
});
