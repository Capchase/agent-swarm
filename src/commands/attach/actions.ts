import type { AttachClient } from "./api";
import { ApiError } from "./api";
import type { InputCommand } from "./logic";
import type { Agent, TaskDetail } from "./types";

export const HELP_TEXT = [
  "plain text   queue a message for the running task (or start a new task when none runs)",
  "/steer <m>   interrupt with a message (only if the harness supports it)",
  "/cancel      cancel the running task",
  "/new <m>     start a follow-up task with this message",
  "/status      show task and agent status",
  "/help        show this list",
  "/quit        leave. The task keeps running.",
].join("\n");

export const CANCEL_NOTICE = "cancel requested. The worker stops the process within about 30 s.";
export const NO_INTERRUPT_NOTICE = "this harness cannot interrupt. Use /cancel, then /new <text>.";

export type ActionContext = {
  client: Pick<AttachClient, "steer" | "cancel" | "createTask">;
  agent: Agent;
  getTask: () => TaskDetail | null;
  setTask: (t: TaskDetail) => void;
  onTaskSwitch: (id: string) => void;
};

/** Run one parsed command. Returns notices to show and whether to quit. */
export async function handleInput(
  ctx: ActionContext,
  cmd: InputCommand,
): Promise<{ notices: string[]; quit?: boolean }> {
  const task = ctx.getTask();
  try {
    switch (cmd.kind) {
      case "invalid":
        return { notices: [cmd.error] };
      case "help":
        return { notices: [HELP_TEXT] };
      case "quit":
        return { notices: [], quit: true };
      case "status":
        return {
          notices: [
            `task ${task ? `${task.id} ${task.status}` : "none"} · agent ${ctx.agent.name} ${ctx.agent.status}`,
          ],
        };
      case "queue": {
        if (!task) return { notices: ["no task to queue onto. Use /new <text>."] };
        const r = await ctx.client.steer(task.id, {
          message: cmd.message,
          mode: "queue",
          onUnsupported: "degrade",
          source: "api",
        });
        const notices = [`${r.outcome} (message ${r.steeringMessageId?.slice(0, 8) ?? "?"})`];
        if (r.outcome === "promoted") {
          notices.push(`no live delivery, follow-up task ${r.promotedTaskId}`);
        }
        return { notices };
      }
      case "steer": {
        if (!task) return { notices: ["no task to steer. Use /new <text>."] };
        if (!task.supportedSteerModes?.includes("steer")) {
          return { notices: [NO_INTERRUPT_NOTICE] };
        }
        try {
          const r = await ctx.client.steer(task.id, {
            message: cmd.message,
            mode: "steer",
            onUnsupported: "fail",
            source: "api",
          });
          return { notices: [`${r.outcome} (message ${r.steeringMessageId?.slice(0, 8) ?? "?"})`] };
        } catch (err) {
          if (err instanceof ApiError && err.status === 422) {
            return { notices: [NO_INTERRUPT_NOTICE] };
          }
          throw err;
        }
      }
      case "cancel":
        if (!task) return { notices: ["no task to cancel."] };
        await ctx.client.cancel(task.id);
        return { notices: [CANCEL_NOTICE] };
      case "new": {
        const t = await ctx.client.createTask({
          task: cmd.message,
          agentId: ctx.agent.id,
          ...(task ? { parentTaskId: task.id } : {}),
          routingReason: task ? "continuity" : "human_pinned",
          source: "api",
          tags: ["attach-cli"],
        });
        ctx.setTask(t);
        ctx.onTaskSwitch(t.id);
        return { notices: [`created task ${t.id} (${t.status})`] };
      }
    }
  } catch (err) {
    return { notices: [`error: ${err instanceof Error ? err.message : String(err)}`] };
  }
}
