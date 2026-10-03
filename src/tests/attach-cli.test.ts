import { describe, expect, test } from "bun:test";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc";

const cli = ["bun", "src/cli.tsx"];
const env = {
  ...process.env,
  AGENT_SWARM_CLI_CONFIG: "/tmp/attach-cli-test-missing/cli.json",
} as Record<string, string | undefined>;
delete env.AGENT_SWARM_API_KEY;
delete env.API_KEY;
delete env.MCP_BASE_URL;

describe("attach cli", () => {
  test(
    "help",
    async () => {
      const r = await runChild([...cli, "attach", "help"], { env });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("attach setup");
      expect(r.stdout).toContain("/steer <text>");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "no args prints help",
    async () => {
      const r = await runChild([...cli, "attach"], { env });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("attach setup");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "setup against a dead server fails and names the url",
    async () => {
      const r = await runChild(
        [...cli, "attach", "setup", "--api-url", "http://127.0.0.1:1", "--token", "aswt_x"],
        { env },
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("http://127.0.0.1:1");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "attach without credentials points to setup",
    async () => {
      const r = await runChild([...cli, "attach", "Sully", "--json"], { env });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("attach setup");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
