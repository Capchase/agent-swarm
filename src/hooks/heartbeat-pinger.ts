#!/usr/bin/env bun
/**
 * Background heartbeat pinger spawned by `hook.ts`'s PreToolUse handler around a
 * Bash tool call and killed by the matching PostToolUse call.
 *
 * `PostToolUse` only fires once a tool call finishes, so a single long silent
 * Bash command (`pnpm install`, `nx affected --target=test`, a CI-watch sleep
 * loop) previously left `active_sessions.lastHeartbeatAt` stale for the whole
 * command duration. The heartbeat sweep's stale-heartbeat classifier (Case B,
 * `src/heartbeat/heartbeat.ts`) would then supersede the still-healthy task and
 * dispatch a crash-recovery resume onto the same worktree.
 *
 * This process runs in the SAME container as the worker session (spawned by its
 * own PreToolUse hook), so it can assert liveness the way the session itself
 * would: by calling the existing worker→API heartbeat endpoint on a short
 * interval, well under the sweep's stale thresholds — no cross-container `ps`
 * introspection required.
 */

import pkg from "../../package.json";

const SERVER_NAME = pkg.config?.name ?? "agent-swarm";

const PING_INTERVAL_MS = Number(process.env.HEARTBEAT_PINGER_INTERVAL_MS) || 60_000;
// Safety net only: PostToolUse is expected to kill this process. If that signal
// is ever missed (hard crash, forced kill of the hook), this cap stops the
// pinger from asserting liveness forever for a call that may itself be dead.
const MAX_LIFETIME_MS = Number(process.env.HEARTBEAT_PINGER_MAX_LIFETIME_MS) || 4 * 60 * 60 * 1000;

interface McpServerConfig {
  url: string;
  headers: Record<string, string>;
}

async function loadMcpConfig(): Promise<McpServerConfig | undefined> {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  try {
    const mcpFile = Bun.file(`${projectDir}/.mcp.json`);
    if (!(await mcpFile.exists())) return undefined;
    const config = await mcpFile.json();
    return config?.mcpServers?.[SERVER_NAME] as McpServerConfig | undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const taskId = process.argv[2];
  if (!taskId) return;

  const mcpConfig = await loadMcpConfig();
  if (!mcpConfig) return;

  let baseUrl: string;
  try {
    baseUrl = new URL(mcpConfig.url).origin;
  } catch {
    return;
  }

  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  const deadline = Date.now() + MAX_LIFETIME_MS;

  while (!stopped && Date.now() < deadline) {
    await Bun.sleep(PING_INTERVAL_MS);
    if (stopped) break;
    try {
      await fetch(`${baseUrl}/api/active-sessions/heartbeat/${taskId}`, {
        method: "PUT",
        headers: mcpConfig.headers,
      });
    } catch {
      // Server may be briefly unreachable — keep trying on the next tick.
    }
  }
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
