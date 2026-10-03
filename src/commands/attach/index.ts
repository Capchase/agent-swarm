import { render } from "ink";
import { createElement } from "react";
import { promptHiddenInput, promptTextInput } from "../codex-login";
import { type ActionContext, handleInput } from "./actions";
import { ApiError, createClient } from "./api";
import { configPath, readConfig, resolveCredentials, writeConfig } from "./config";
import { emit, emitEvent, runJsonInput } from "./json-view";
import { matchAgent } from "./logic";
import { type AttachEvent, startPoller } from "./poller";
import type { TaskDetail } from "./types";
import { AttachView } from "./view";

export type AttachFlags = {
  apiUrl?: string;
  token?: string;
  task?: string;
  prompt?: string;
  pollMs?: number;
  json: boolean;
  yes: boolean;
};

const HELP = `agent-swarm attach: control one swarm agent from this terminal

Usage:
  agent-swarm attach setup [--api-url <url>] [--token <aswt_...>] [--yes]
  agent-swarm attach <agent-name> [--task <task-id>] [--prompt <text>] [--json] [--poll-ms <n>]

Options:
  setup                 Validate and store the API URL and user token in ~/.config/agent-swarm/cli.json
  <agent-name>          Attach to the agent's running task, or start a new one
  --task <task-id>      Attach to this task, or continue from it
  --prompt <text>       First message when no task runs
  --json                One JSON object per line, commands from stdin
  --poll-ms <n>         Log poll interval (default 3000)

Interactive commands: /steer <text>, /cancel, /new <text>, /status, /help, /quit`;

export function parseFlags(argv: string[]): AttachFlags {
  const f: AttachFlags = { json: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--api-url") f.apiUrl = next();
    else if (a === "--token") f.token = next();
    else if (a === "--task") f.task = next();
    else if (a === "--prompt") f.prompt = next();
    else if (a === "--poll-ms") f.pollMs = Number(next());
    else if (a === "--json") f.json = true;
    else if (a === "--yes" || a === "-y") f.yes = true;
  }
  return f;
}

function fail(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

export async function runAttachCommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (!sub || sub === "help" || argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }
  if (sub === "setup") return runSetup(parseFlags(argv.slice(1)));
  // Flags before the agent name are not supported: `attach <agent> [flags]`.
  return runAttach(sub, parseFlags(argv.slice(1)));
}

async function runSetup(flags: AttachFlags): Promise<void> {
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const envUrl = process.env.MCP_BASE_URL?.trim();
  const defaultUrl = envUrl || "http://localhost:3013";
  const apiUrl = (
    flags.apiUrl || (tty ? await promptTextInput("Swarm API URL", defaultUrl) : defaultUrl)
  )
    .trim()
    .replace(/\/+$/, "");
  const token =
    flags.token ||
    (tty
      ? await promptHiddenInput("User token (aswt_...)", "")
      : fail("--token is required without a TTY"));
  if (!apiUrl || !token) fail("API URL and token are required.");

  let who: Awaited<ReturnType<ReturnType<typeof createClient>["whoami"]>>;
  try {
    who = await createClient({ apiUrl, token }).whoami();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) fail(`Token rejected (401) by ${apiUrl}.`);
    fail(`Could not reach ${apiUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (who.kind !== "user") {
    console.log(
      "Warning: this is the shared operator key, not a personal aswt_ token. Actions will not be attributed to you.",
    );
    if (!flags.yes) {
      if (!tty) fail("Refusing to save an operator key without --yes.");
      const answer = await promptTextInput("Save it anyway? (y/N)", "");
      if (!/^y(es)?$/i.test(answer)) fail("Aborted.");
    }
  }
  const path = configPath();
  await writeConfig(path, {
    apiUrl,
    token,
    userId: who.user?.id,
    userName: who.user?.name,
    savedAt: new Date().toISOString(),
  });
  console.log(
    `Token ok: ${who.user ? `user ${who.user.name} (${who.user.id.slice(0, 8)})` : "operator key"}. Saved ${path} (mode 0600).`,
  );
}

async function runAttach(name: string, flags: AttachFlags): Promise<void> {
  let creds: ReturnType<typeof resolveCredentials>;
  try {
    creds = resolveCredentials(flags, process.env, await readConfig(configPath()));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const client = createClient(creds);

  let agent: Awaited<ReturnType<typeof client.listAgents>>[number];
  let task: TaskDetail | null = null;
  try {
    const m = matchAgent(await client.listAgents(), name);
    if (!m.ok) {
      const list = m.candidates.map((a) => `  ${a.name} · ${a.role ?? "-"} · ${a.status}`);
      fail(
        m.reason === "ambiguous"
          ? `Name "${name}" matches more than one agent:\n${list.join("\n")}`
          : `No agent named "${name}".${list.length ? `\nDid you mean:\n${list.join("\n")}` : ""}`,
      );
    }
    agent = m.agent;
    if (flags.task) {
      task = await client.getTask(flags.task);
      if (task.agentId && task.agentId !== agent.id) {
        console.error(`Warning: task ${task.id} belongs to a different agent.`);
      }
    } else {
      const [running] = await client.listTasks({
        agentId: agent.id,
        status: "in_progress",
        limit: 1,
      });
      task = running ? await client.getTask(running.id) : null;
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  let current: TaskDetail | null = task;
  let poller: ReturnType<typeof startPoller> | null = null;
  let sink: (e: AttachEvent) => void = emitEvent;
  const onEvent = (e: AttachEvent) => sink(e);
  const startOrSwitch = (id: string) => {
    if (poller) poller.switchTask(id);
    else poller = startPoller(client, id, { pollMs: flags.pollMs, onEvent });
  };
  const ctx: ActionContext = {
    client,
    agent,
    getTask: () => current,
    setTask: (t) => {
      current = t;
    },
    onTaskSwitch: startOrSwitch,
  };

  if (!current && flags.prompt) {
    const res = await handleInput(ctx, { kind: "new", message: flags.prompt });
    if (flags.json) for (const n of res.notices) emit({ type: "notice", message: n });
    else for (const n of res.notices) console.log(n);
    if (!current) fail("Could not start a task.");
  }

  if (flags.json) {
    if (!current) {
      console.error(JSON.stringify({ error: "no task; pass --prompt or --task" }));
      process.exit(2);
    }
    emit({
      type: "attached",
      agent: agent.name,
      taskId: (current as TaskDetail).id,
      status: (current as TaskDetail).status,
    });
    if (!poller) startOrSwitch((current as TaskDetail).id);
    await runJsonInput(ctx, () => {
      (poller as ReturnType<typeof startPoller> | null)?.stop();
      process.exit(0);
    });
    return;
  }

  if (current && !poller) startOrSwitch(current.id);
  const instance = render(
    createElement(AttachView, {
      agent,
      initialTask: current,
      makeContext: (state) => {
        ctx.getTask = state.getTask;
        ctx.setTask = state.setTask;
        return ctx;
      },
      subscribe: (s) => {
        sink = s;
      },
      onQuit: () => {
        (poller as ReturnType<typeof startPoller> | null)?.stop();
      },
    }),
  );
  await instance.waitUntilExit();
  (poller as ReturnType<typeof startPoller> | null)?.stop();
}
