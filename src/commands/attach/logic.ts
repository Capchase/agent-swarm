import { normalizeSessionLogs, type SessionLogRecord } from "../../../apps/ui/src/logs-parser";
import type { Agent, SessionLog } from "./types";

export type MatchResult =
  | { ok: true; agent: Agent }
  | { ok: false; reason: "none" | "ambiguous"; candidates: Agent[] };

export function matchAgent(agents: Agent[], name: string): MatchResult {
  const needle = name.trim().toLowerCase();
  const exact = agents.filter((a) => a.name.toLowerCase() === needle);
  const [only] = exact;
  if (exact.length === 1 && only) return { ok: true, agent: only };
  if (exact.length > 1) return { ok: false, reason: "ambiguous", candidates: exact };
  return {
    ok: false,
    reason: "none",
    candidates: agents.filter((a) => a.name.toLowerCase().includes(needle)),
  };
}

export type InputCommand =
  | { kind: "queue"; message: string }
  | { kind: "steer"; message: string }
  | { kind: "cancel" }
  | { kind: "new"; message: string }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "quit" }
  | { kind: "invalid"; error: string };

export function parseInput(line: string, taskIsTerminalOrNone: boolean): InputCommand {
  const text = line.trim();
  if (!text) return { kind: "invalid", error: "empty" };
  if (!text.startsWith("/")) {
    return taskIsTerminalOrNone ? { kind: "new", message: text } : { kind: "queue", message: text };
  }
  const space = text.indexOf(" ");
  const cmd = space === -1 ? text : text.slice(0, space);
  const rest = space === -1 ? "" : text.slice(space + 1).trim();
  switch (cmd) {
    case "/steer":
      return rest
        ? { kind: "steer", message: rest }
        : { kind: "invalid", error: "/steer needs a message" };
    case "/new":
      return rest
        ? { kind: "new", message: rest }
        : { kind: "invalid", error: "/new needs a message" };
    case "/cancel":
      return { kind: "cancel" };
    case "/status":
      return { kind: "status" };
    case "/help":
      return { kind: "help" };
    case "/quit":
      return { kind: "quit" };
    default:
      return { kind: "invalid", error: `unknown command ${cmd}` };
  }
}

export function newRows(seen: Set<string>, rows: SessionLog[]): SessionLog[] {
  const fresh: SessionLog[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    fresh.push(row);
  }
  return fresh;
}

const MAX_LINE = 200;
const cut = (s: string) => (s.length > MAX_LINE ? `${s.slice(0, MAX_LINE)}…` : s);

export function renderItems(rows: SessionLog[]): string[] {
  const { items } = normalizeSessionLogs(rows as SessionLogRecord[]);
  const lines: string[] = [];
  for (const item of items) {
    const time = item.createdAt ? item.createdAt.slice(11, 19) : "";
    let body: string;
    if (item.tool) {
      const t = item.tool as { name?: string; input?: unknown };
      body = `${t.name ?? "tool"} ${JSON.stringify(t.input ?? {})}`;
    } else if (item.text) {
      body = item.text.replace(/\s+/g, " ").trim();
    } else if (item.result) {
      body = cut(JSON.stringify(item.result));
    } else {
      continue;
    }
    lines.push(`[${time}] ${item.role ?? item.kind}: ${cut(body)}`);
  }
  return lines;
}
