import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ApiConfig, checkCompletedProcesses } from "../commands/runner";
import type { ProviderResult } from "../providers/types";

/**
 * Completion-path regression for a `credits_required` seat mismatch: the
 * runner awaits `POST /api/keys/report-seat-mismatch` before it finishes the
 * task, sends the credential and model family, and never reports a key-wide
 * rate limit.
 */

type RunnerStateArg = Parameters<typeof checkCompletedProcesses>[0];

interface RecordedRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  at: number;
}

const SEAT_REPORT_DELAY_MS = 150;
let requests: RecordedRequest[] = [];
let seatReportRespondedAt: number | undefined;
let originalFetch: typeof fetch;

beforeAll(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    const rawBody = typeof init?.body === "string" ? init.body : "";
    requests.push({ method, path, body: rawBody ? JSON.parse(rawBody) : null, at: Date.now() });

    if (path === "/api/keys/report-seat-mismatch") {
      await Bun.sleep(SEAT_REPORT_DELAY_MS);
      seatReportRespondedAt = Date.now();
      return Response.json({ success: true, message: "recorded" });
    }
    if (method === "POST" && /^\/api\/tasks\/[^/]+\/finish$/.test(path)) {
      return Response.json({ success: true, task: { status: "failed" } });
    }
    return Response.json({ success: true });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function makeState(taskId: string, result: ProviderResult, model: string): RunnerStateArg {
  const task = {
    taskId,
    session: {},
    logFile: "/tmp/runner-seat-mismatch.jsonl",
    startTime: new Date(),
    promise: Promise.resolve(result),
    result,
    credentialInfo: { keyType: "CLAUDE_CODE_OAUTH_TOKEN", keySuffix: "TJAAA", keyIndex: 3 },
    harnessProvider: "claude",
    hasLocalEnvironment: false,
    model,
  };
  return {
    activeTasks: new Map([[taskId, task]]),
    maxConcurrent: 1,
    startedAt: Date.now(),
    tasksProcessed: 0,
    harnessProvider: "claude",
    codexCreditsExhaustedCooldownMs: 2 * 60 * 60 * 1000,
    modelWindowBlocks: new Map(),
  } as unknown as RunnerStateArg;
}

const apiConfig: ApiConfig = {
  apiUrl: "http://runner-seat-mismatch.test",
  apiKey: "example-test-key",
  agentId: "00000000-0000-4000-8000-000000000001",
};

describe("checkCompletedProcesses — credits_required seat mismatch", () => {
  test("awaits the seat report before finishing and never reports a key-wide limit", async () => {
    requests = [];
    seatReportRespondedAt = undefined;
    const taskId = "11111111-1111-4111-8111-111111111111";
    const result: ProviderResult = {
      exitCode: 1,
      sessionId: "session-1",
      isError: true,
      failureReason: "Fable 5.1 requires usage credits. Switch to another model to continue.",
      creditsRequired: {
        observedAt: new Date().toISOString(),
        overageDisabledReason: "member_zero_credit_limit",
      },
    };
    const state = makeState(taskId, result, "claude-fable-5-1");

    await checkCompletedProcesses(state, "worker", apiConfig);

    const seatReports = requests.filter((r) => r.path === "/api/keys/report-seat-mismatch");
    expect(seatReports).toHaveLength(1);
    expect(seatReports[0]?.method).toBe("POST");
    expect(seatReports[0]?.body).toEqual({
      keyType: "CLAUDE_CODE_OAUTH_TOKEN",
      keySuffix: "TJAAA",
      keyIndex: 3,
      model: "fable",
    });

    const finish = requests.find((r) => r.path === `/api/tasks/${taskId}/finish`);
    expect(finish).toBeDefined();
    expect(seatReportRespondedAt).toBeDefined();
    expect(finish!.at).toBeGreaterThanOrEqual(seatReportRespondedAt!);

    expect(requests.some((r) => r.path === "/api/keys/report-rate-limit")).toBe(false);
    expect(state.modelWindowBlocks.size).toBe(0);
  });
});
