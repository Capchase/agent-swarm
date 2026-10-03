import { TextInput } from "@inkjs/ui";
import { Box, Static, Text, useApp } from "ink";
import { useEffect, useRef, useState } from "react";
import { type ActionContext, handleInput } from "./actions";
import { parseInput } from "./logic";
import type { AttachEvent } from "./poller";
import { type Agent, type TaskDetail, TERMINAL_STATUSES } from "./types";

type Line = { id: number; text: string; color?: string };

export type AttachViewProps = {
  agent: Agent;
  initialTask: TaskDetail | null;
  /** Build the action context once the view owns the task state. */
  makeContext: (state: {
    getTask: () => TaskDetail | null;
    setTask: (t: TaskDetail) => void;
  }) => ActionContext;
  /** Register the sink the poller writes events to. */
  subscribe: (sink: (e: AttachEvent) => void) => void;
  onQuit: () => void;
};

export function AttachView({
  agent,
  initialTask,
  makeContext,
  subscribe,
  onQuit,
}: AttachViewProps) {
  const { exit } = useApp();
  const [lines, setLines] = useState<Line[]>([]);
  const [task, setTaskState] = useState<TaskDetail | null>(initialTask);
  const taskRef = useRef<TaskDetail | null>(initialTask);
  const nextId = useRef(0);
  const ctxRef = useRef<ActionContext | null>(null);

  const push = (text: string, color?: string) =>
    setLines((l) => [...l, { id: nextId.current++, text, color }]);

  const setTask = (t: TaskDetail) => {
    taskRef.current = t;
    setTaskState(t);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once on mount; refs hold live state
  useEffect(() => {
    ctxRef.current = makeContext({ getTask: () => taskRef.current, setTask });
    subscribe((e) => {
      if (e.type === "log") push(e.line);
      else if (e.type === "task") {
        setTask(e.task);
        push(`task ${e.status}`, "cyan");
      } else if (e.type === "steering") {
        push(
          `steering ${e.id.slice(0, 8)} ${e.status}${e.promotedTaskId ? ` -> task ${e.promotedTaskId}` : ""}`,
          "yellow",
        );
      } else push(`error: ${e.message}`, "red");
    });
    push(
      initialTask
        ? `attached to task ${initialTask.id} (${initialTask.status}). /help for commands.`
        : "No running task. Type the first message to start one. /help for commands.",
      "gray",
    );
  }, []);

  const submit = async (line: string) => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const t = taskRef.current;
    const cmd = parseInput(line, !t || TERMINAL_STATUSES.has(t.status));
    const res = await handleInput(ctx, cmd);
    for (const n of res.notices) push(n, "green");
    if (res.quit) {
      onQuit();
      exit();
    }
  };

  const modes = task?.supportedSteerModes?.join(",") || "none yet";
  return (
    <Box flexDirection="column">
      <Text bold>
        {agent.name} ({agent.role ?? "agent"}) · {agent.harnessProvider ?? "?"} · {agent.status} ·
        steer modes: {modes}
      </Text>
      <Static items={lines}>
        {(l) => (
          <Text key={l.id} color={l.color}>
            {l.text}
          </Text>
        )}
      </Static>
      <Box>
        <Text bold>{"> "}</Text>
        <TextInput key={lines.length} placeholder="message or /help" onSubmit={submit} />
      </Box>
    </Box>
  );
}
