import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ApiConfig,
  ensureTaskFinished,
  getBridgeFailureDiagnostics,
  handleStructuredOutputFallback,
} from "../commands/runner";

// Configurable mock responses per test
let mockGetTask: Record<string, unknown> | null = null;
let mockGetTaskStatus = 200;
let lastFinishBody: Record<string, unknown> | null = null;
let mockFinishResponse: Record<string, unknown> = { success: true };
let mockFetchError: Error | null = null;
let originalFetch: typeof fetch;
// Result the mocked `claude -p --json-schema` extraction call (invoked by
// handleStructuredOutputFallback's claude-adapter branch) resolves with.
// null means "extraction fails" (mirrors the real `.catch(() => null)`).
let mockClaudeExtractionResult: Record<string, unknown> | null = null;
let originalBunShell: typeof Bun.$;
// Captures the tagged-template args of the last `Bun.$`claude -p ...``` call
// so tests can assert on the exact extraction prompt handleStructuredOutputFallback
// sent — in particular, whether it included the captured providerOutput.
let lastBunShellArgs: unknown[] | null = null;

function resetMocks() {
  mockGetTask = null;
  mockGetTaskStatus = 200;
  lastFinishBody = null;
  mockFinishResponse = { success: true };
  mockFetchError = null;
  mockClaudeExtractionResult = null;
  lastBunShellArgs = null;
}

function makeConfig(): ApiConfig {
  return {
    apiUrl: "http://runner-fallback.test",
    apiKey: "test-key",
    agentId: "test-agent-id",
  };
}

beforeAll(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    if (mockFetchError) throw mockFetchError;

    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const parsedUrl = new URL(url);
    const method = init?.method ?? "GET";

    if (method === "GET" && /^\/api\/tasks\/[^/]+$/.test(parsedUrl.pathname)) {
      if (!mockGetTask) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: mockGetTaskStatus,
        });
      }
      return new Response(JSON.stringify(mockGetTask), {
        status: mockGetTaskStatus,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (method === "POST" && /^\/api\/tasks\/[^/]+\/finish$/.test(parsedUrl.pathname)) {
      const body = typeof init?.body === "string" ? init.body : "";
      lastFinishBody = body ? JSON.parse(body) : null;
      return new Response(JSON.stringify(mockFinishResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  }) as typeof fetch;

  // Stub the shell tag Bun.$ so handleStructuredOutputFallback's claude-adapter
  // extraction branch (`Bun.$`claude -p ... --json-schema ...`.json()`) never
  // spawns the real CLI in a unit test.
  originalBunShell = Bun.$;
  Bun.$ = ((...args: unknown[]) => {
    lastBunShellArgs = args;
    return {
      json: async () => {
        if (mockClaudeExtractionResult === null) {
          throw new Error("mock claude extraction not configured for this test");
        }
        return mockClaudeExtractionResult;
      },
    };
  }) as unknown as typeof Bun.$;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  Bun.$ = originalBunShell;
});

describe("handleStructuredOutputFallback", () => {
  test("returns no-schema with lastProgress when task has progress logs", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-1",
      task: "Do something",
      status: "in_progress",
      output: null,
      progress: "older progress",
      logs: [
        { eventType: "task_progress", newValue: "first update", createdAt: "2025-01-01T00:00:00Z" },
        {
          eventType: "task_progress",
          newValue: "latest update",
          createdAt: "2025-01-01T01:00:00Z",
        },
        {
          eventType: "task_status_change",
          newValue: "in_progress",
          createdAt: "2025-01-01T00:00:00Z",
        },
      ],
    };

    const result = await handleStructuredOutputFallback(makeConfig(), "task-1", "claude");
    expect(result).toEqual({ kind: "no-schema", lastProgress: "latest update" });
  });

  test("returns no-schema with progress field when no progress logs exist", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-2",
      task: "Do something",
      status: "in_progress",
      output: null,
      progress: "some progress text",
      logs: [],
    };

    const result = await handleStructuredOutputFallback(makeConfig(), "task-2", "claude");
    expect(result).toEqual({ kind: "no-schema", lastProgress: "some progress text" });
  });

  test("returns no-schema without lastProgress when no progress at all", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-3",
      task: "Do something",
      status: "in_progress",
      output: null,
      progress: null,
      logs: [],
    };

    const result = await handleStructuredOutputFallback(makeConfig(), "task-3", "claude");
    expect(result).toEqual({ kind: "no-schema", lastProgress: undefined });
  });

  test("returns already-has-output when task has output and outputSchema", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-4",
      task: "Do something",
      status: "completed",
      output: '{"result": "done"}',
      outputSchema: { type: "object", properties: { result: { type: "string" } } },
      logs: [],
    };

    const result = await handleStructuredOutputFallback(makeConfig(), "task-4", "claude");
    expect(result).toEqual({ kind: "already-has-output" });
  });

  test("returns fetch-error when API returns non-200", async () => {
    resetMocks();
    mockGetTask = null;
    mockGetTaskStatus = 500;

    const result = await handleStructuredOutputFallback(makeConfig(), "task-5", "claude");
    expect(result).toEqual({ kind: "fetch-error", error: "HTTP 500" });
  });

  test("returns schema-fail for non-claude adapter with outputSchema", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-6",
      task: "Do something",
      status: "in_progress",
      output: null,
      outputSchema: { type: "object", properties: { result: { type: "string" } } },
      logs: [],
    };

    const result = await handleStructuredOutputFallback(makeConfig(), "task-6", "pi-mono");
    expect(result).toEqual({
      kind: "schema-fail",
      failReason: "Structured output required by outputSchema but not provided via store-progress",
    });
  });

  test("returns fetch-error on network error", async () => {
    resetMocks();
    mockFetchError = new Error("network down");

    const result = await handleStructuredOutputFallback(makeConfig(), "task-7", "claude");
    expect(result.kind).toBe("fetch-error");
    expect((result as { kind: "fetch-error"; error: string }).error).toBeTruthy();
  });
});

describe("ensureTaskFinished", () => {
  test("does not back-fill progress narration into output for no-schema fallback", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-10",
      task: "Do work",
      status: "in_progress",
      output: null,
      progress: null,
      logs: [
        {
          eventType: "task_progress",
          newValue: "📋 Checking task list",
          createdAt: "2025-01-01T00:00:00Z",
        },
      ],
    };

    await ensureTaskFinished(makeConfig(), "worker", "task-10", 0);

    expect(lastFinishBody).toBeTruthy();
    expect(lastFinishBody!.status).toBe("completed");
    // The tool-narration progress line must never become the task output —
    // an honest "no output captured" sentinel is preferable to a misleading
    // tool label.
    expect(lastFinishBody!.output).toBe("Process completed successfully (no output captured)");
  });

  test("sets generic message when no-schema and no progress", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-11",
      task: "Do work",
      status: "in_progress",
      output: null,
      progress: null,
      logs: [],
    };

    await ensureTaskFinished(makeConfig(), "worker", "task-11", 0);

    expect(lastFinishBody).toBeTruthy();
    expect(lastFinishBody!.status).toBe("completed");
    expect(lastFinishBody!.output).toBe("Process completed successfully (no output captured)");
  });

  test("uses provider output when no outputSchema exists", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-provider-output",
      task: "Do work",
      status: "in_progress",
      output: null,
      progress: null,
      logs: [],
    };

    await ensureTaskFinished(
      makeConfig(),
      "worker",
      "task-provider-output",
      0,
      undefined,
      "Provider final answer",
      "pi",
    );

    expect(lastFinishBody).toBeTruthy();
    expect(lastFinishBody!.status).toBe("completed");
    expect(lastFinishBody!.output).toBe("Provider final answer");
  });

  test("accepts provider output that satisfies outputSchema", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-provider-schema-valid",
      task: "Do work",
      status: "in_progress",
      output: null,
      outputSchema: {
        type: "object",
        required: ["result"],
        properties: { result: { type: "string" } },
      },
      logs: [],
    };

    await ensureTaskFinished(
      makeConfig(),
      "worker",
      "task-provider-schema-valid",
      0,
      undefined,
      '{"result":"ok"}',
      "pi",
    );

    expect(lastFinishBody).toBeTruthy();
    expect(lastFinishBody!.status).toBe("completed");
    expect(lastFinishBody!.output).toBe('{"result":"ok"}');
  });

  test("fails provider output that violates outputSchema", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-provider-schema-invalid",
      task: "Do work",
      status: "in_progress",
      output: null,
      outputSchema: {
        type: "object",
        required: ["result"],
        properties: { result: { type: "string" } },
      },
      logs: [],
    };

    await ensureTaskFinished(
      makeConfig(),
      "worker",
      "task-provider-schema-invalid",
      0,
      undefined,
      "plain text",
      "pi",
    );

    expect(lastFinishBody).toBeTruthy();
    expect(lastFinishBody!.status).toBe("failed");
    expect(lastFinishBody!.failureReason).toContain("outputSchema");
  });

  test("falls through to extraction instead of failing when the claude adapter's free-text output violates outputSchema", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-provider-schema-fallthrough",
      task: "Do work",
      status: "in_progress",
      output: null,
      outputSchema: {
        type: "object",
        required: ["result"],
        properties: { result: { type: "string" } },
      },
      logs: [
        {
          eventType: "task_progress",
          newValue: "⚡ Doing the work",
          createdAt: "2025-01-01T00:00:00Z",
        },
      ],
    };
    mockClaudeExtractionResult = { result: "extracted via fallback" };

    // providerOutput is the agent's real free-form final message (Change 1) —
    // it doesn't satisfy the task's outputSchema, but that must not regress
    // the task from "extracted" to "failed" (the one risk called out for
    // this fix): it should fall through to the existing claude -p
    // --json-schema extraction fallback and still succeed.
    await ensureTaskFinished(
      makeConfig(),
      "worker",
      "task-provider-schema-fallthrough",
      0,
      undefined,
      "Here's a free-form summary of what I did, not JSON.",
      "claude",
    );

    expect(lastFinishBody).toBeTruthy();
    expect(lastFinishBody!.status).toBe("completed");
    expect(lastFinishBody!.output).toBe(JSON.stringify({ result: "extracted via fallback" }));
  });

  test("fails the task when free-text output violates outputSchema AND the extraction fallback itself fails", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-provider-schema-fallthrough-extraction-fails",
      task: "Do work",
      status: "in_progress",
      output: null,
      outputSchema: {
        type: "object",
        required: ["result"],
        properties: { result: { type: "string" } },
      },
      logs: [
        {
          eventType: "task_progress",
          newValue: "⚡ Doing the work",
          createdAt: "2025-01-01T00:00:00Z",
        },
      ],
    };
    // mockClaudeExtractionResult stays null (via resetMocks) — the mocked
    // `claude -p --json-schema` call throws, mirroring the real `.catch(() =>
    // null)` extraction-failure path. This is the guard the fallthrough test
    // above doesn't cover: a genuine schema violation must still surface as
    // a real failure, not get silently masked by the fallthrough.
    await ensureTaskFinished(
      makeConfig(),
      "worker",
      "task-provider-schema-fallthrough-extraction-fails",
      0,
      undefined,
      "Here's a free-form summary of what I did, not JSON.",
      "claude",
    );

    expect(lastFinishBody).toBeTruthy();
    expect(lastFinishBody!.status).toBe("failed");
    expect(lastFinishBody!.failureReason).toContain("Structured output extraction fallback failed");
  });

  test("extraction prompt includes the captured providerOutput, not just progress history", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-provider-schema-fallthrough-prompt-source",
      task: "Do work",
      status: "in_progress",
      output: null,
      outputSchema: {
        type: "object",
        required: ["result"],
        properties: { result: { type: "string" } },
      },
      logs: [
        {
          eventType: "task_progress",
          newValue: "⚡ Doing the work",
          createdAt: "2025-01-01T00:00:00Z",
        },
      ],
    };
    mockClaudeExtractionResult = { result: "extracted via fallback" };
    const finalMessage = "UNIQUE-FINAL-ANSWER-TOKEN-42: the result is done.";

    // Deliberate design choice (Finding 2, option a): the extraction prompt
    // is built from BOTH the agent's captured free-form final message AND
    // progress history — the final message is the agent's own stated
    // conclusion and a strictly richer extraction source than chronological
    // progress narration alone. Pin that the prompt actually carries it.
    await ensureTaskFinished(
      makeConfig(),
      "worker",
      "task-provider-schema-fallthrough-prompt-source",
      0,
      undefined,
      finalMessage,
      "claude",
    );

    expect(lastFinishBody!.status).toBe("completed");
    expect(lastBunShellArgs).toBeTruthy();
    // Tagged-template call: args[0] is the literal-string-parts array,
    // args[1] is the interpolated `extractionPrompt` value.
    const extractionPrompt = lastBunShellArgs?.[1];
    expect(typeof extractionPrompt).toBe("string");
    expect(extractionPrompt as string).toContain(finalMessage);
  });

  test("sets failed status for schema-fail fallback", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-12",
      task: "Do work",
      status: "in_progress",
      output: null,
      outputSchema: { type: "object" },
      logs: [],
    };
    // Force a non-claude adapter via env. The factory at
    // src/providers/index.ts accepts "pi" (NOT "pi-mono") — the prior
    // test value was a typo that silently fell into the unknown-provider
    // error path instead of exercising the pi branch.
    const origProvider = process.env.HARNESS_PROVIDER;
    process.env.HARNESS_PROVIDER = "pi";

    await ensureTaskFinished(makeConfig(), "worker", "task-12", 0);

    process.env.HARNESS_PROVIDER = origProvider;

    expect(lastFinishBody).toBeTruthy();
    expect(lastFinishBody!.status).toBe("failed");
    expect(lastFinishBody!.failureReason).toContain("outputSchema");
  });

  test("schema-fail fallback also works under HARNESS_PROVIDER=codex", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-12c",
      task: "Do work",
      status: "in_progress",
      output: null,
      outputSchema: { type: "object" },
      logs: [],
    };
    const origProvider = process.env.HARNESS_PROVIDER;
    process.env.HARNESS_PROVIDER = "codex";

    await ensureTaskFinished(makeConfig(), "worker", "task-12c", 0);

    process.env.HARNESS_PROVIDER = origProvider;

    expect(lastFinishBody).toBeTruthy();
    expect(lastFinishBody!.status).toBe("failed");
    expect(lastFinishBody!.failureReason).toContain("outputSchema");
  });

  test("handles alreadyFinished gracefully", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-13",
      task: "Do work",
      status: "in_progress",
      output: null,
      progress: null,
      logs: [],
    };
    mockFinishResponse = { success: true, alreadyFinished: true, task: { status: "completed" } };

    // Should not throw
    await ensureTaskFinished(makeConfig(), "worker", "task-13", 0);
    expect(lastFinishBody).toBeTruthy();
  });

  test("sends failure reason when exit code is non-zero", async () => {
    resetMocks();

    await ensureTaskFinished(makeConfig(), "worker", "task-14", 1, "Out of memory");

    expect(lastFinishBody).toBeTruthy();
    expect(lastFinishBody!.status).toBe("failed");
    expect(lastFinishBody!.failureReason).toBe("Out of memory");
  });

  test("appends failure diagnostics when exit code is non-zero", async () => {
    resetMocks();

    await ensureTaskFinished(
      makeConfig(),
      "worker",
      "task-14b",
      1,
      "Session error (exit code 1): Unknown error",
      undefined,
      "claude",
      "Claude bridge final tmux pane tail (/tmp/run/tmux-pane-final.txt):\nraw pane tail",
    );

    expect(lastFinishBody).toBeTruthy();
    expect(lastFinishBody!.status).toBe("failed");
    expect(lastFinishBody!.failureReason).toBe(
      "Session error (exit code 1): Unknown error\n\nClaude bridge final tmux pane tail (/tmp/run/tmux-pane-final.txt):\nraw pane tail",
    );
  });

  test("does not leak a long progress narration into output either", async () => {
    resetMocks();
    const longProgress = "x".repeat(3000);
    mockGetTask = {
      id: "task-15",
      task: "Do work",
      status: "in_progress",
      output: null,
      progress: longProgress,
      logs: [],
    };

    await ensureTaskFinished(makeConfig(), "worker", "task-15", 0);

    expect(lastFinishBody).toBeTruthy();
    expect(lastFinishBody!.output).toBe("Process completed successfully (no output captured)");
  });
});

describe("getBridgeFailureDiagnostics", () => {
  test("returns latest tmux pane artifact and 40-line tail", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "runner-bridge-diagnostics-"));
    try {
      const older = join(cwd, ".claude-bridge/runs/2026-01-01T00-00-00-000Z-old");
      const newer = join(cwd, ".claude-bridge/runs/2026-01-01T00-00-01-000Z-new");
      await mkdir(older, { recursive: true });
      await mkdir(newer, { recursive: true });
      await Bun.write(join(older, "tmux-pane-final.txt"), "old pane");
      await Bun.write(
        join(newer, "tmux-pane-final.txt"),
        Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join("\n"),
      );

      const diagnostics = await getBridgeFailureDiagnostics(cwd);

      expect(diagnostics?.artifactPath).toBe(join(newer, "tmux-pane-final.txt"));
      expect(diagnostics?.paneTail?.startsWith("line 6\nline 7")).toBe(true);
      expect(diagnostics?.paneTail?.endsWith("line 45")).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
