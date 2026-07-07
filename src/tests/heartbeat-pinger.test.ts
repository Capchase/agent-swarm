/**
 * Real-mechanism tests for the long-Bash-call heartbeat pinger
 * (`src/hooks/heartbeat-pinger.ts` + `spawnHeartbeatPinger`/`killHeartbeatPinger`
 * in `src/hooks/hook.ts`).
 *
 * This replaces PR #54's `ps`-based liveness probe, which was rejected in
 * review: the probe ran in the API server's own container and could never see
 * a worker's `claude` process in the deployed (separate-container) topology,
 * so its two unit tests — which stubbed the probe via
 * `setSessionProcessLivenessProbeForTests` — proved nothing about production
 * behavior.
 *
 * These tests instead spawn the REAL `heartbeat-pinger.ts` subprocess (via the
 * real `spawnHeartbeatPinger`, not a stub) and point it at a real local HTTP
 * server standing in for the API, so they exercise the actual mechanism: a
 * worker-owned process pinging the existing heartbeat endpoint over HTTP from
 * inside its own container — not OS process-table introspection across a
 * container boundary.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heartbeatPingerPidFile, killHeartbeatPinger, spawnHeartbeatPinger } from "../hooks/hook";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(stepMs);
  }
  throw new Error("waitUntil: condition never became true within timeout");
}

const tempDirs: string[] = [];
const toolUseIds: string[] = [];

async function setupFakeProject(): Promise<{
  projectDir: string;
  hits: Array<{ url: string; method: string }>;
  server: ReturnType<typeof Bun.serve>;
}> {
  const projectDir = await mkdtemp(join(tmpdir(), "heartbeat-pinger-test-"));
  tempDirs.push(projectDir);

  const hits: Array<{ url: string; method: string }> = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      hits.push({ url: url.pathname, method: req.method });
      return new Response("{}", { status: 200 });
    },
  });

  await Bun.write(
    `${projectDir}/.mcp.json`,
    JSON.stringify({
      mcpServers: {
        "agent-swarm": {
          url: `http://127.0.0.1:${server.port}/mcp`,
          headers: { Authorization: "Bearer test-token", "X-Agent-ID": "agent-test" },
        },
      },
    }),
  );

  return { projectDir, hits, server };
}

afterEach(async () => {
  for (const toolUseId of toolUseIds.splice(0)) {
    await killHeartbeatPinger(toolUseId).catch(() => {});
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("heartbeat pinger (real subprocess + real HTTP server)", () => {
  test("spawns a live process that PUTs to the heartbeat endpoint on an interval", async () => {
    const taskId = "task-pinger-1";
    const toolUseId = `tool-use-${Date.now()}-1`;
    toolUseIds.push(toolUseId);

    const { projectDir, hits, server } = await setupFakeProject();
    try {
      process.env.HEARTBEAT_PINGER_INTERVAL_MS = "50";
      spawnHeartbeatPinger(taskId, toolUseId, projectDir);

      const pidFile = heartbeatPingerPidFile(toolUseId);
      await waitUntil(async () => await Bun.file(pidFile).exists());
      const pid = Number((await Bun.file(pidFile).text()).trim());
      expect(Number.isFinite(pid) && pid > 0).toBe(true);
      expect(isProcessAlive(pid)).toBe(true);

      await waitUntil(
        () =>
          hits.some(
            (h) => h.url === `/api/active-sessions/heartbeat/${taskId}` && h.method === "PUT",
          ),
        3000,
      );

      // Keep pinging on a second tick — proves it's a loop, not a one-shot.
      const firstCount = hits.length;
      await waitUntil(() => hits.length > firstCount, 3000);
    } finally {
      delete process.env.HEARTBEAT_PINGER_INTERVAL_MS;
      server.stop(true);
    }
  });

  test("PostToolUse kill stops the process and further pings", async () => {
    const taskId = "task-pinger-2";
    const toolUseId = `tool-use-${Date.now()}-2`;

    const { projectDir, hits, server } = await setupFakeProject();
    try {
      process.env.HEARTBEAT_PINGER_INTERVAL_MS = "50";
      spawnHeartbeatPinger(taskId, toolUseId, projectDir);

      const pidFile = heartbeatPingerPidFile(toolUseId);
      await waitUntil(async () => await Bun.file(pidFile).exists());
      const pid = Number((await Bun.file(pidFile).text()).trim());

      await waitUntil(() => hits.length > 0, 3000);

      await killHeartbeatPinger(toolUseId);

      // Pid file removed and the OS process actually exits.
      expect(await Bun.file(pidFile).exists()).toBe(false);
      await waitUntil(() => !isProcessAlive(pid), 2000);

      const countAtKill = hits.length;
      await Bun.sleep(250);
      expect(hits.length).toBe(countAtKill);
    } finally {
      delete process.env.HEARTBEAT_PINGER_INTERVAL_MS;
      server.stop(true);
    }
  });

  test("killHeartbeatPinger is a no-op when no pinger was ever spawned for that tool_use_id", async () => {
    await expect(
      killHeartbeatPinger(`tool-use-never-spawned-${Date.now()}`),
    ).resolves.toBeUndefined();
  });
});
