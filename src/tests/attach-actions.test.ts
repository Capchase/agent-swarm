import { describe, expect, test } from "bun:test";
import { type ActionContext, handleInput } from "../commands/attach/actions";
import { ApiError, type CreateTaskBody, type SteerBody } from "../commands/attach/api";
import type { SteerMode, TaskDetail } from "../commands/attach/types";

function ctx(
  task: TaskDetail | null,
  modes: SteerMode[],
  steerOutcome: object = { outcome: "queued", steeringMessageId: "abcdef123456" },
) {
  const steers: SteerBody[] = [];
  const creates: CreateTaskBody[] = [];
  let current = task && { ...task, supportedSteerModes: modes };
  const c: ActionContext = {
    client: {
      steer: async (_id: string, b: SteerBody) => {
        steers.push(b);
        if (b.onUnsupported === "fail" && !modes.includes(b.mode))
          throw new ApiError(422, "x", null);
        return steerOutcome as never;
      },
      cancel: async () => ({ success: true, task: task as never }),
      createTask: async (b: CreateTaskBody) => {
        creates.push(b);
        return { id: "new1", task: b.task, status: "pending" } as never;
      },
    },
    agent: { id: "a1", name: "Sully", status: "idle" },
    getTask: () => current,
    setTask: (t) => {
      current = t;
    },
    onTaskSwitch: () => {},
  };
  return { c, steers, creates };
}
const running: TaskDetail = { id: "t1", task: "x", status: "in_progress" };

describe("handleInput", () => {
  test("queue degrades", async () => {
    const { c, steers } = ctx(running, ["queue"]);
    await handleInput(c, { kind: "queue", message: "m" });
    expect(steers[0]).toMatchObject({ mode: "queue", onUnsupported: "degrade" });
  });
  test("steer without support does not call the API", async () => {
    const { c, steers } = ctx(running, ["queue"]);
    const r = await handleInput(c, { kind: "steer", message: "m" });
    expect(steers.length).toBe(0);
    expect(r.notices[0]).toContain("cannot interrupt");
  });
  test("steer with support uses fail", async () => {
    const { c, steers } = ctx(running, ["steer", "queue"], { outcome: "steered" });
    await handleInput(c, { kind: "steer", message: "m" });
    expect(steers[0]).toMatchObject({ mode: "steer", onUnsupported: "fail" });
  });
  test("new with task sends parent + continuity", async () => {
    const { c, creates } = ctx(running, ["queue"]);
    await handleInput(c, { kind: "new", message: "m" });
    expect(creates[0]).toMatchObject({ parentTaskId: "t1", routingReason: "continuity" });
  });
  test("new without task is human_pinned, no parent", async () => {
    const { c, creates } = ctx(null, []);
    await handleInput(c, { kind: "new", message: "m" });
    expect(creates[0]?.routingReason).toBe("human_pinned");
    expect(creates[0]?.parentTaskId).toBeUndefined();
  });
  test("promoted notice names the follow-up task", async () => {
    const { c } = ctx(running, ["queue"], { outcome: "promoted", promotedTaskId: "p9" });
    const r = await handleInput(c, { kind: "queue", message: "m" });
    expect(r.notices.join(" ")).toContain("p9");
  });
  test("cancel and quit", async () => {
    const { c } = ctx(running, ["queue"]);
    expect((await handleInput(c, { kind: "cancel" })).notices[0]).toContain("cancel requested");
    expect((await handleInput(c, { kind: "quit" })).quit).toBe(true);
  });
});
