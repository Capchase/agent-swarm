/**
 * Runner-level tests for `resolveTrustDirectories` / `canonicalizeTrustDirectory`
 * (src/commands/runner.ts) — the wiring `spawnProviderProcess` uses to build
 * `ProviderSessionConfig.trustDirectories` for Claude sessions.
 *
 * `spawnProviderProcess` itself is private and impractical to invoke directly
 * (it spawns real adapters, tracing spans, and outbound HTTP calls — see the
 * same note in `model-control.test.ts`), so this exercises the extracted,
 * exported helpers directly: real `/api/repos` fetching against a stub
 * server, and the canonicalization/worker-root enforcement that gates which
 * directories are allowed to suppress Claude's trust prompt.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalizeTrustDirectory,
  fetchRegisteredRepoClonePaths,
  resolveTrustDirectories,
} from "../commands/runner";

let server: ReturnType<typeof Bun.serve>;
let testUrl: string;
let reposResponse: { status: number; body: unknown };

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/repos") {
        return new Response(JSON.stringify(reposResponse.body), {
          status: reposResponse.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  testUrl = server.url.toString().replace(/\/$/, "");
});

afterAll(() => {
  server.stop(true);
});

describe("fetchRegisteredRepoClonePaths", () => {
  test("returns clonePath values from /api/repos", async () => {
    reposResponse = {
      status: 200,
      body: {
        repos: [
          { clonePath: "/workspace/personal/repos/a" },
          { clonePath: "/workspace/personal/repos/b" },
        ],
      },
    };
    const paths = await fetchRegisteredRepoClonePaths(testUrl, "key");
    expect(paths).toEqual(["/workspace/personal/repos/a", "/workspace/personal/repos/b"]);
  });

  test("returns [] on a non-200 response", async () => {
    reposResponse = { status: 500, body: { error: "boom" } };
    expect(await fetchRegisteredRepoClonePaths(testUrl, "key")).toEqual([]);
  });

  test("returns [] when the API is unreachable", async () => {
    expect(await fetchRegisteredRepoClonePaths("http://localhost:19999", "key")).toEqual([]);
  });
});

describe("canonicalizeTrustDirectory", () => {
  test("keeps a path that resolves under /workspace", async () => {
    expect(await canonicalizeTrustDirectory("/workspace/personal")).toBe("/workspace/personal");
  });

  test("keeps a not-yet-existing path under /workspace (normalized, not realpath'd)", async () => {
    const candidate = "/workspace/personal/repos/not-cloned-yet";
    expect(await canonicalizeTrustDirectory(candidate)).toBe(candidate);
  });

  test("rejects a path outside /workspace — the clonePath/task-dir escape this guards against", async () => {
    expect(await canonicalizeTrustDirectory("/etc")).toBeNull();
    expect(await canonicalizeTrustDirectory("/home/worker")).toBeNull();
  });

  test("normalizes .. segments before checking the root (rejects an escape via traversal)", async () => {
    expect(await canonicalizeTrustDirectory("/workspace/../etc")).toBeNull();
  });

  describe("symlink escape", () => {
    let fixtureDir: string;

    afterEach(async () => {
      if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
    });

    test("rejects a /workspace symlink that resolves outside the root", async () => {
      fixtureDir = await mkdtemp(join("/workspace", ".trust-canonicalize-test-"));
      const outsideTarget = await mkdtemp(join(tmpdir(), "trust-escape-target-"));
      const linkPath = join(fixtureDir, "escape");
      await symlink(outsideTarget, linkPath);

      expect(await canonicalizeTrustDirectory(linkPath)).toBeNull();
      await rm(outsideTarget, { recursive: true, force: true });
    });

    test("keeps a /workspace symlink that resolves back inside the root", async () => {
      fixtureDir = await mkdtemp(join("/workspace", ".trust-canonicalize-test-"));
      const realTarget = join(fixtureDir, "real");
      await mkdir(realTarget);
      const linkPath = join(fixtureDir, "alias");
      await symlink(realTarget, linkPath);

      expect(await canonicalizeTrustDirectory(linkPath)).toBe(realTarget);
    });
  });
});

describe("resolveTrustDirectories", () => {
  test("propagates canonicalized /api/repos clonePaths alongside the fixed worker roots and cwd", async () => {
    reposResponse = {
      status: 200,
      body: { repos: [{ clonePath: "/workspace/personal/repos/agent-swarm" }] },
    };
    const dirs = await resolveTrustDirectories(
      testUrl,
      "key",
      "/workspace/personal/repos/agent-swarm",
    );

    expect(dirs).toContain("/workspace");
    expect(dirs).toContain("/workspace/personal");
    expect(dirs).toContain("/workspace/personal/repos/agent-swarm");
    // De-duplicated: cwd and the fetched clonePath coincide.
    expect(dirs.filter((d) => d === "/workspace/personal/repos/agent-swarm")).toHaveLength(1);
  });

  test("drops an out-of-root clonePath instead of propagating it into the trusted set", async () => {
    reposResponse = {
      status: 200,
      body: { repos: [{ clonePath: "/etc" }, { clonePath: "/workspace/personal/repos/safe" }] },
    };
    const dirs = await resolveTrustDirectories(testUrl, "key", "/workspace/personal/repos/safe");

    expect(dirs).not.toContain("/etc");
    expect(dirs).toContain("/workspace/personal/repos/safe");
  });
});
