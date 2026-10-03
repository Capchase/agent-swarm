import type { AttachClient } from "./api";
import { newRows, renderItems } from "./logic";
import { type SessionLog, type TaskDetail, type TaskStatus, TERMINAL_STATUSES } from "./types";

export type AttachEvent =
  | { type: "log"; line: string; row: SessionLog }
  | { type: "task"; status: TaskStatus; task: TaskDetail }
  | { type: "steering"; id: string; status: string; promotedTaskId?: string }
  | { type: "error"; message: string };

export type PollerClient = Pick<AttachClient, "sessionLogs" | "getTask" | "steeringMessages">;

export function startPoller(
  client: PollerClient,
  initialTaskId: string,
  opts: { pollMs?: number; statusEveryMs?: number; onEvent: (e: AttachEvent) => void },
): { stop(): void; switchTask(id: string): void } {
  const pollMs = opts.pollMs ?? 3000;
  const statusEveryMs = opts.statusEveryMs ?? 5000;
  let taskId = initialTaskId;
  let seen = new Set<string>();
  let lastStatus: string | null = null;
  let lastSteering = new Map<string, string>();
  let lastStatusCheck = 0;
  let quietPolls = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const reset = () => {
    seen = new Set();
    lastStatus = null;
    lastSteering = new Map();
    lastStatusCheck = 0;
    quietPolls = 0;
  };

  async function tick() {
    if (stopped) return;
    const id = taskId;
    try {
      const fresh = newRows(seen, await client.sessionLogs(id, 1000));
      if (id !== taskId) return schedule();
      for (const row of fresh) {
        for (const line of renderItems([row])) opts.onEvent({ type: "log", line, row });
      }
      quietPolls = fresh.length === 0 ? quietPolls + 1 : 0;
      if (Date.now() - lastStatusCheck >= statusEveryMs || lastStatus === null) {
        lastStatusCheck = Date.now();
        const t = await client.getTask(id);
        if (id !== taskId) return schedule();
        if (t.status !== lastStatus) {
          lastStatus = t.status;
          opts.onEvent({ type: "task", status: t.status, task: t });
        }
        for (const m of await client.steeringMessages(id)) {
          if (lastSteering.get(m.id) !== m.status) {
            lastSteering.set(m.id, m.status);
            opts.onEvent({
              type: "steering",
              id: m.id,
              status: m.status,
              promotedTaskId: m.promotedTaskId ?? undefined,
            });
          }
        }
      }
    } catch (err) {
      opts.onEvent({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
    schedule();
  }

  function schedule() {
    if (stopped) return;
    // Back off once the task is terminal and the log stream is quiet.
    const idle = lastStatus !== null && TERMINAL_STATUSES.has(lastStatus) && quietPolls >= 2;
    timer = setTimeout(tick, idle ? Math.max(pollMs * 3, 1000) : pollMs);
  }

  timer = setTimeout(tick, 0);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    switchTask(id: string) {
      taskId = id;
      reset();
    },
  };
}
