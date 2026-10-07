/**
 * A real `src/http.ts` process logs a line when a request starts, before the
 * completion line, so an event-loop stall mid-request is visible in the logs
 * (SAV-6951). `HTTP_LOG_REQUEST_START=false` turns the start line off.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm, unlink } from "node:fs/promises";
import type { Subprocess } from "bun";
import { getFreePort, SERVER_BOOT_HOOK_TIMEOUT_MS, waitForServer } from "./test-net";

const API_KEY = "example-test-http-request-start-log-key";

interface Api {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  base: string;
  stdout: Promise<string>;
  dbPath: string;
  fsDir: string;
}

const booted: Api[] = [];

async function bootApi(env: Record<string, string>): Promise<Api> {
  const port = await getFreePort();
  const stamp = `${Date.now()}-${port}`;
  const dbPath = `/tmp/test-http-start-log-${stamp}.sqlite`;
  const fsDir = `/tmp/test-http-start-log-fs-${stamp}`;
  const proc = Bun.spawn(["bun", "src/http.ts"], {
    cwd: `${import.meta.dir}/../..`,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: dbPath,
      API_KEY,
      AGENT_FS_LOCAL_DIR: fsDir,
      AGENT_FS_API_URL: "",
      API_AGENT_FS_API_KEY: "",
      AGENT_FS_API_KEY: "",
      SLACK_BOT_TOKEN: "",
      GITHUB_WEBHOOK_SECRET: "",
      AGENTMAIL_API_KEY: "",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(proc.stdout).text();
  void new Response(proc.stderr).text();
  const api: Api = { proc, base: `http://127.0.0.1:${port}`, stdout, dbPath, fsDir };
  booted.push(api);
  await waitForServer(`${api.base}/health`);
  return api;
}

async function healthLogLines(api: Api): Promise<string[]> {
  const res = await fetch(`${api.base}/health`);
  expect(res.status).toBe(200);
  // Stop the child so the stdout pipe closes and the full log can be read.
  api.proc.kill("SIGTERM");
  await api.proc.exited;
  return (await api.stdout).split("\n").filter((line) => line.includes("GET /health"));
}

afterEach(async () => {
  for (const api of booted.splice(0)) {
    if (api.proc.exitCode === null) api.proc.kill("SIGKILL");
    await api.proc.exited.catch(() => {});
    await rm(api.fsDir, { recursive: true, force: true }).catch(() => {});
    for (const suffix of ["", "-wal", "-shm"]) await unlink(api.dbPath + suffix).catch(() => {});
  }
});

describe("HTTP request-start log", () => {
  test(
    "logs the start line before the completion line",
    async () => {
      const lines = await healthLogLines(await bootApi({}));
      const start = lines.findIndex((line) => line.startsWith("[HTTP] → GET /health"));
      const done = lines.findIndex((line) => line.includes("→ 200"));
      expect(start).toBeGreaterThanOrEqual(0);
      expect(done).toBeGreaterThan(start);
    },
    SERVER_BOOT_HOOK_TIMEOUT_MS,
  );

  test(
    "HTTP_LOG_REQUEST_START=false omits the start line",
    async () => {
      const lines = await healthLogLines(await bootApi({ HTTP_LOG_REQUEST_START: "false" }));
      expect(lines.some((line) => line.startsWith("[HTTP] → GET /health"))).toBe(false);
      expect(lines.some((line) => line.includes("→ 200"))).toBe(true);
    },
    SERVER_BOOT_HOOK_TIMEOUT_MS,
  );
});
