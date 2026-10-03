import { describe, expect, test } from "bun:test";
import { matchAgent, newRows, parseInput, renderItems } from "../commands/attach/logic";
import type { Agent, SessionLog } from "../commands/attach/types";

const ag = (id: string, name: string): Agent => ({ id, name, status: "idle" });

describe("matchAgent", () => {
  test("exact, case-insensitive", () => {
    const r = matchAgent([ag("1", "Sully"), ag("2", "Otto")], "sully");
    expect(r.ok && r.agent.id).toBe("1");
  });
  test("ambiguous", () => {
    const r = matchAgent([ag("1", "Sully"), ag("2", "Sully")], "Sully");
    expect(!r.ok && r.reason).toBe("ambiguous");
  });
  test("none lists candidates", () => {
    const r = matchAgent([ag("1", "Sully")], "Sul");
    expect(!r.ok && r.reason).toBe("none");
    expect(!r.ok && r.candidates.map((a) => a.name)).toEqual(["Sully"]);
  });
});

describe("parseInput", () => {
  test("commands", () => {
    expect(parseInput("/steer go left", false)).toEqual({ kind: "steer", message: "go left" });
    expect(parseInput("/cancel", false)).toEqual({ kind: "cancel" });
    expect(parseInput("/new hi", false)).toEqual({ kind: "new", message: "hi" });
    expect(parseInput("/status", false)).toEqual({ kind: "status" });
    expect(parseInput("/help", false)).toEqual({ kind: "help" });
    expect(parseInput("/quit", false)).toEqual({ kind: "quit" });
  });
  test("plain text", () => {
    expect(parseInput("hello", false).kind).toBe("queue");
    expect(parseInput("hello", true).kind).toBe("new");
  });
  test("invalid", () => {
    expect(parseInput("/steer", false).kind).toBe("invalid");
    expect(parseInput("/new", false).kind).toBe("invalid");
    expect(parseInput("/zzz", false).kind).toBe("invalid");
    expect(parseInput("  ", false).kind).toBe("invalid");
  });
});

const row: SessionLog = {
  id: "r1",
  taskId: "t",
  sessionId: "s",
  iteration: 1,
  cli: "claude",
  lineNumber: 1,
  createdAt: "2026-10-03T14:02:14.000Z",
  content: JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
  }),
};

test("newRows dedups", () => {
  const seen = new Set<string>();
  expect(newRows(seen, [row]).length).toBe(1);
  expect(newRows(seen, [row])).toEqual([]);
});

test("renderItems renders text", () => {
  const lines = renderItems([row]);
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain("hello");
});
