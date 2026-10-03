import { createInterface } from "node:readline";
import { type ActionContext, handleInput } from "./actions";
import { parseInput } from "./logic";
import type { AttachEvent } from "./poller";
import { TERMINAL_STATUSES } from "./types";

export function emit(obj: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...obj })}\n`);
}

export function emitEvent(e: AttachEvent): void {
  if (e.type === "log") emit({ type: "log", line: e.line });
  else if (e.type === "task") emit({ type: "task", status: e.status, taskId: e.task.id });
  else emit({ ...e });
}

/** Read one command per line from stdin until /quit or end of input. */
export async function runJsonInput(ctx: ActionContext, onQuit: () => void): Promise<void> {
  const rl = createInterface({ input: process.stdin });
  const queue: string[] = [];
  let busy = false;
  let closed = false;
  let quit = false;
  let finished = false;

  const drain = async () => {
    if (busy) return;
    busy = true;
    while (queue.length && !quit) {
      const line = queue.shift() as string;
      const t = ctx.getTask();
      const cmd = parseInput(line, !t || TERMINAL_STATUSES.has(t.status));
      const res = await handleInput(ctx, cmd);
      for (const n of res.notices) emit({ type: "notice", message: n });
      if (res.quit) quit = true;
    }
    busy = false;
    if (!finished && ((closed && queue.length === 0) || quit)) {
      finished = true;
      rl.close();
      onQuit();
    }
  };

  rl.on("line", (l) => {
    queue.push(l);
    void drain();
  });
  rl.on("close", () => {
    closed = true;
    void drain();
  });
}
