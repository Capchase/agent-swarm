import { describe, expect, test } from "bun:test";
import { ApiError } from "../commands/attach/api";
import { type AttachEvent, type PollerClient, startPoller } from "../commands/attach/poller";
import type { SessionLog, SteeringMessage, TaskDetail } from "../commands/attach/types";

const mk = (id: string): SessionLog => ({
  id,
  taskId: "t",
  sessionId: "s",
  iteration: 1,
  cli: "claude",
  lineNumber: Number(id.slice(1)),
  createdAt: "2026-10-03T14:02:14.000Z",
  content: JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: `msg ${id}` }] },
  }),
});

async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
}

function setup(over: Partial<PollerClient> = {}) {
  const events: AttachEvent[] = [];
  const client: PollerClient = {
    sessionLogs: async () => [mk("r1"), mk("r2"), mk("r3")],
    getTask: async () => ({ id: "t", task: "x", status: "pending" }) as TaskDetail,
    steeringMessages: async () => [],
    ...over,
  };
  const p = startPoller(client, "t", {
    pollMs: 5,
    statusEveryMs: 0,
    onEvent: (e) => events.push(e),
  });
  return { events, p };
}

describe("poller", () => {
  test("same rows emitted once", async () => {
    const { events, p } = setup();
    await until(() => events.filter((e) => e.type === "task").length >= 1);
    await new Promise((r) => setTimeout(r, 40));
    p.stop();
    expect(events.filter((e) => e.type === "log").length).toBe(3);
  });
  test("status change emits one task event", async () => {
    let status: "pending" | "in_progress" = "pending";
    const { events, p } = setup({
      getTask: async () => ({ id: "t", task: "x", status }) as TaskDetail,
    });
    await until(() => events.some((e) => e.type === "task"));
    status = "in_progress";
    await until(() => events.filter((e) => e.type === "task").length === 2);
    await new Promise((r) => setTimeout(r, 30));
    p.stop();
    expect(events.filter((e) => e.type === "task").length).toBe(2);
  });
  test("steering status change emits one event", async () => {
    let st: SteeringMessage["status"] = "pending";
    const { events, p } = setup({
      steeringMessages: async () => [{ id: "m1", body: "b", mode: "queue", status: st }],
    });
    await until(() => events.some((e) => e.type === "steering"));
    st = "delivered";
    await until(() => events.filter((e) => e.type === "steering").length === 2);
    p.stop();
  });
  test("API error emits error and loop continues", async () => {
    let n = 0;
    const { events, p } = setup({
      sessionLogs: async () => {
        if (n++ === 0) throw new ApiError(500, "boom", null);
        return [mk("r1")];
      },
    });
    await until(() => events.some((e) => e.type === "log"));
    p.stop();
    expect(events.filter((e) => e.type === "error").length).toBe(1);
  });
  test("switchTask clears seen", async () => {
    const { events, p } = setup();
    await until(() => events.filter((e) => e.type === "log").length === 3);
    p.switchTask("t2");
    await until(() => events.filter((e) => e.type === "log").length === 6);
    p.stop();
  });
});
