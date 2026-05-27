/**
 * Tests for the docker-entrypoint.sh swarm_config → env-var export filter.
 *
 * Reproduces the bug: keys like CF-Access-Client-Id contain hyphens and are not
 * valid POSIX shell identifiers. Writing them to /tmp/swarm_config.env and
 * sourcing it causes the shell to interpret `CF-Access-Client-Id=value` as a
 * command, not an assignment, crashing the export with "command not found".
 *
 * The fix filters out any key that does not match ^[A-Za-z_][A-Za-z0-9_]*$.
 */
import { describe, expect, test } from "bun:test";

const JQ_FILTER =
  '.configs[] | select(.key != "codex_oauth" and .key != "HARNESS_PROVIDER") | select(.key | test("^[A-Za-z_][A-Za-z0-9_]*$")) | "\\(.key)=" + (.value | @sh)';

/** Build a minimal resolved-config JSON payload like /api/config/resolved returns. */
function buildConfigJson(entries: Array<{ key: string; value: string }>): string {
  return JSON.stringify({
    configs: entries.map((e) => ({ key: e.key, value: e.value, scope: "global" })),
  });
}

/** Run the jq filter against the config JSON and return stdout lines. */
async function runJqFilter(configJson: string): Promise<string[]> {
  const proc = Bun.spawn(["jq", "-r", JQ_FILTER], {
    stdin: new TextEncoder().encode(configJson),
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text.split("\n").filter(Boolean);
}

describe("entrypoint swarm_config env-var export filter", () => {
  test("exports valid identifier keys as KEY=value lines", async () => {
    const json = buildConfigJson([{ key: "FOO", value: "bar" }]);
    const lines = await runJqFilter(json);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("FOO='bar'");
  });

  test("skips keys with hyphens (e.g. CF-Access-Client-Id)", async () => {
    const json = buildConfigJson([
      { key: "FOO", value: "1" },
      { key: "CF-Access-Client-Id", value: "secret" },
      { key: "BAR", value: "2" },
    ]);
    const lines = await runJqFilter(json);
    expect(lines).toHaveLength(2);
    const keys = lines.map((l) => l.split("=")[0]);
    expect(keys).toContain("FOO");
    expect(keys).toContain("BAR");
    expect(keys).not.toContain("CF-Access-Client-Id");
  });

  test("skips keys starting with a digit", async () => {
    const json = buildConfigJson([
      { key: "VALID_KEY", value: "ok" },
      { key: "1INVALID", value: "bad" },
    ]);
    const lines = await runJqFilter(json);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith("VALID_KEY=")).toBe(true);
  });

  test("skips keys with dots or slashes", async () => {
    const json = buildConfigJson([
      { key: "GOOD", value: "yes" },
      { key: "some.dotted.key", value: "nope" },
      { key: "path/key", value: "nope" },
    ]);
    const lines = await runJqFilter(json);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith("GOOD=")).toBe(true);
  });

  test("still skips the hardcoded exclusions codex_oauth and HARNESS_PROVIDER", async () => {
    const json = buildConfigJson([
      { key: "MY_KEY", value: "keep" },
      { key: "codex_oauth", value: "blob" },
      { key: "HARNESS_PROVIDER", value: "claude" },
    ]);
    const lines = await runJqFilter(json);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith("MY_KEY=")).toBe(true);
  });

  test("accepts underscore-prefixed keys", async () => {
    const json = buildConfigJson([{ key: "_PRIVATE_KEY", value: "val" }]);
    const lines = await runJqFilter(json);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith("_PRIVATE_KEY=")).toBe(true);
  });

  test("shell-quotes values containing special characters", async () => {
    const json = buildConfigJson([{ key: "MY_TOKEN", value: "abc def$foo" }]);
    const lines = await runJqFilter(json);
    expect(lines).toHaveLength(1);
    // @sh in jq wraps in single-quotes and escapes embedded single-quotes
    expect(lines[0]).toBe("MY_TOKEN='abc def$foo'");
  });
});
