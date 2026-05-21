/**
 * Unit tests for injectPrAssignee in src/hooks/hook.ts.
 *
 * Exercises command detection, no-op conditions, assignee injection,
 * and all error-path returns (never throws).
 *
 * Uses real TASK_FILE temp-files + a mock fetch via globalThis.fetch so the
 * logic under test is identical to production, only the network is stubbed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { injectPrAssignee } from "../hooks/hook";

// ── helpers ───────────────────────────────────────────────────────────────────

async function writeTempTaskFile(data: Record<string, unknown>): Promise<string> {
  const path = `/tmp/pr-assignee-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  await Bun.write(path, JSON.stringify(data));
  return path;
}

const MOCK_API_URL = "http://localhost:3999";
const MOCK_HEADERS = { Authorization: "Bearer test-key" };
const TASK_ID = "task-abc-123";
const USER_ID = "user-xyz-456";
const GH_USERNAME = "danielcapchase";

type FetchHandler = (
  url: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

let fetchHandler: FetchHandler | null = null;
const origFetch = globalThis.fetch;

beforeEach(() => {
  // Default: task with requestedByUserId → user with github identity
  fetchHandler = async (url) => {
    if (url.includes(`/api/tasks/${TASK_ID}`)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: TASK_ID, requestedByUserId: USER_ID }),
      };
    }
    if (url.includes(`/api/users/${USER_ID}`)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: USER_ID,
          name: "Daniel",
          identities: [
            { kind: "slack", externalId: "U12345" },
            { kind: "github", externalId: GH_USERNAME },
          ],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  // @ts-expect-error — override for tests
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    return fetchHandler!(urlStr, init);
  };
});

afterEach(() => {
  globalThis.fetch = origFetch;
  fetchHandler = null;
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("injectPrAssignee", () => {
  describe("gh pr create — injection", () => {
    test("appends --assignee for a simple gh pr create", async () => {
      const taskFile = await writeTempTaskFile({ taskId: TASK_ID });
      try {
        const result = await injectPrAssignee('gh pr create --title "feat: thing" --body "body"', {
          taskFilePath: taskFile,
          apiUrl: MOCK_API_URL,
          apiHeaders: MOCK_HEADERS,
        });
        expect(result).toBe(
          `gh pr create --title "feat: thing" --body "body" --assignee ${GH_USERNAME}`,
        );
      } finally {
        await unlink(taskFile).catch(() => {});
      }
    });

    test("handles piped command: cat ... | gh pr create ...", async () => {
      const taskFile = await writeTempTaskFile({ taskId: TASK_ID });
      try {
        const cmd = 'cat body.md | gh pr create --title "fix" --body-file -';
        const result = await injectPrAssignee(cmd, {
          taskFilePath: taskFile,
          apiUrl: MOCK_API_URL,
          apiHeaders: MOCK_HEADERS,
        });
        expect(result).toBe(`${cmd} --assignee ${GH_USERNAME}`);
      } finally {
        await unlink(taskFile).catch(() => {});
      }
    });

    test("handles heredoc command", async () => {
      const taskFile = await writeTempTaskFile({ taskId: TASK_ID });
      try {
        const cmd = `gh pr create --title "feat" --body "$(cat <<'EOF'\nbody\nEOF\n)"`;
        const result = await injectPrAssignee(cmd, {
          taskFilePath: taskFile,
          apiUrl: MOCK_API_URL,
          apiHeaders: MOCK_HEADERS,
        });
        expect(result).toContain("--assignee");
        expect(result).toContain(GH_USERNAME);
      } finally {
        await unlink(taskFile).catch(() => {});
      }
    });
  });

  describe("gh pr create — no-op cases", () => {
    test("no-op when --assignee already present (space form)", async () => {
      const taskFile = await writeTempTaskFile({ taskId: TASK_ID });
      try {
        const cmd = `gh pr create --title "t" --assignee existing-user`;
        const result = await injectPrAssignee(cmd, {
          taskFilePath: taskFile,
          apiUrl: MOCK_API_URL,
          apiHeaders: MOCK_HEADERS,
        });
        expect(result).toBe(cmd);
      } finally {
        await unlink(taskFile).catch(() => {});
      }
    });

    test("no-op when --assignee already present (= form)", async () => {
      const cmd = `gh pr create --title "t" --assignee=existing-user`;
      const taskFile = await writeTempTaskFile({ taskId: TASK_ID });
      try {
        const result = await injectPrAssignee(cmd, {
          taskFilePath: taskFile,
          apiUrl: MOCK_API_URL,
          apiHeaders: MOCK_HEADERS,
        });
        expect(result).toBe(cmd);
      } finally {
        await unlink(taskFile).catch(() => {});
      }
    });

    test("does NOT match gh pr create-comment", async () => {
      const cmd = `gh pr create-comment --body "hi"`;
      const taskFile = await writeTempTaskFile({ taskId: TASK_ID });
      try {
        const result = await injectPrAssignee(cmd, {
          taskFilePath: taskFile,
          apiUrl: MOCK_API_URL,
          apiHeaders: MOCK_HEADERS,
        });
        expect(result).toBe(cmd);
      } finally {
        await unlink(taskFile).catch(() => {});
      }
    });

    test("does NOT match unrelated commands", async () => {
      const cmd = `echo 'hello world'`;
      const result = await injectPrAssignee(cmd, {
        apiUrl: MOCK_API_URL,
        apiHeaders: MOCK_HEADERS,
      });
      expect(result).toBe(cmd);
    });
  });

  describe("glab mr create — injection", () => {
    test("appends --assignee-username for glab mr create", async () => {
      const taskFile = await writeTempTaskFile({ taskId: TASK_ID });
      try {
        const result = await injectPrAssignee('glab mr create --title "feat: thing"', {
          taskFilePath: taskFile,
          apiUrl: MOCK_API_URL,
          apiHeaders: MOCK_HEADERS,
        });
        expect(result).toBe(
          `glab mr create --title "feat: thing" --assignee-username ${GH_USERNAME}`,
        );
      } finally {
        await unlink(taskFile).catch(() => {});
      }
    });

    test("no-op when --assignee-username already present", async () => {
      const cmd = `glab mr create --title "t" --assignee-username existing`;
      const taskFile = await writeTempTaskFile({ taskId: TASK_ID });
      try {
        const result = await injectPrAssignee(cmd, {
          taskFilePath: taskFile,
          apiUrl: MOCK_API_URL,
          apiHeaders: MOCK_HEADERS,
        });
        expect(result).toBe(cmd);
      } finally {
        await unlink(taskFile).catch(() => {});
      }
    });
  });

  describe("error paths — never blocks", () => {
    test("returns unchanged when no taskFilePath provided", async () => {
      const cmd = `gh pr create --title "t"`;
      const result = await injectPrAssignee(cmd, {
        apiUrl: MOCK_API_URL,
        apiHeaders: MOCK_HEADERS,
      });
      expect(result).toBe(cmd);
    });

    test("returns unchanged when TASK_FILE does not exist on disk", async () => {
      const cmd = `gh pr create --title "t"`;
      const result = await injectPrAssignee(cmd, {
        taskFilePath: `/tmp/nonexistent-file-${Date.now()}.json`,
        apiUrl: MOCK_API_URL,
        apiHeaders: MOCK_HEADERS,
      });
      expect(result).toBe(cmd);
    });

    test("returns unchanged when task has no requestedByUserId", async () => {
      fetchHandler = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ id: TASK_ID, requestedByUserId: null }),
      });
      const taskFile = await writeTempTaskFile({ taskId: TASK_ID });
      try {
        const cmd = `gh pr create --title "t"`;
        const result = await injectPrAssignee(cmd, {
          taskFilePath: taskFile,
          apiUrl: MOCK_API_URL,
          apiHeaders: MOCK_HEADERS,
        });
        expect(result).toBe(cmd);
      } finally {
        await unlink(taskFile).catch(() => {});
      }
    });

    test("returns unchanged when user has no github identity", async () => {
      fetchHandler = async (url) => {
        if (url.includes("/api/tasks/")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: TASK_ID, requestedByUserId: USER_ID }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: USER_ID,
            name: "Nobody",
            identities: [{ kind: "slack", externalId: "U999" }],
          }),
        };
      };
      const taskFile = await writeTempTaskFile({ taskId: TASK_ID });
      try {
        const cmd = `gh pr create --title "t"`;
        const result = await injectPrAssignee(cmd, {
          taskFilePath: taskFile,
          apiUrl: MOCK_API_URL,
          apiHeaders: MOCK_HEADERS,
        });
        expect(result).toBe(cmd);
      } finally {
        await unlink(taskFile).catch(() => {});
      }
    });

    test("returns unchanged when task API call fails", async () => {
      fetchHandler = async () => ({ ok: false, status: 500, json: async () => ({}) });
      const taskFile = await writeTempTaskFile({ taskId: TASK_ID });
      try {
        const cmd = `gh pr create --title "t"`;
        const result = await injectPrAssignee(cmd, {
          taskFilePath: taskFile,
          apiUrl: MOCK_API_URL,
          apiHeaders: MOCK_HEADERS,
        });
        expect(result).toBe(cmd);
      } finally {
        await unlink(taskFile).catch(() => {});
      }
    });

    test("returns unchanged when fetch throws", async () => {
      // @ts-expect-error — test override
      globalThis.fetch = async () => {
        throw new Error("network error");
      };
      const taskFile = await writeTempTaskFile({ taskId: TASK_ID });
      try {
        const cmd = `gh pr create --title "t"`;
        const result = await injectPrAssignee(cmd, {
          taskFilePath: taskFile,
          apiUrl: MOCK_API_URL,
          apiHeaders: MOCK_HEADERS,
        });
        expect(result).toBe(cmd);
      } finally {
        await unlink(taskFile).catch(() => {});
      }
    });
  });
});
