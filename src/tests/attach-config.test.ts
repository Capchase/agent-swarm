import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, readConfig, resolveCredentials, writeConfig } from "../commands/attach/config";

const dirs: string[] = [];
async function tmp() {
  const d = await mkdtemp(join(tmpdir(), "attach-cfg-"));
  dirs.push(d);
  return d;
}
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("configPath", () => {
  test("override, then XDG, then ~/.config", () => {
    expect(configPath({ AGENT_SWARM_CLI_CONFIG: "/x/c.json", XDG_CONFIG_HOME: "/y" })).toBe(
      "/x/c.json",
    );
    expect(configPath({ XDG_CONFIG_HOME: "/y" })).toBe("/y/agent-swarm/cli.json");
    expect(configPath({})).toBe(join(homedir(), ".config", "agent-swarm", "cli.json"));
  });
});

describe("read/write", () => {
  test("writes mode 0600 file in 0700 dir", async () => {
    const d = await tmp();
    const p = join(d, "sub", "cli.json");
    await writeConfig(p, { apiUrl: "http://x", token: "aswt_a", savedAt: "now" });
    expect((await stat(p)).mode & 0o777).toBe(0o600);
    expect((await stat(join(d, "sub"))).mode & 0o777).toBe(0o700);
    expect((await readConfig(p))?.token).toBe("aswt_a");
  });
  test("tightens an existing loose file", async () => {
    const d = await tmp();
    const p = join(d, "cli.json");
    await writeFile(p, "{}", { mode: 0o644 });
    await writeConfig(p, { apiUrl: "http://x", token: "t", savedAt: "now" });
    expect((await stat(p)).mode & 0o777).toBe(0o600);
  });
  test("missing file returns null", async () => {
    expect(await readConfig(join(await tmp(), "nope.json"))).toBeNull();
  });
  test("invalid JSON throws with path", async () => {
    const p = join(await tmp(), "bad.json");
    await writeFile(p, "{not json");
    await expect(readConfig(p)).rejects.toThrow(p);
  });
});

describe("resolveCredentials", () => {
  const file = { apiUrl: "http://file/", token: "file-tok", savedAt: "n" };
  test("flags beat env beat file", () => {
    const env = { MCP_BASE_URL: "http://env", AGENT_SWARM_API_KEY: "env-tok" };
    expect(resolveCredentials({ apiUrl: "http://flag/", token: "flag-tok" }, env, file)).toEqual({
      apiUrl: "http://flag",
      token: "flag-tok",
      source: "flags",
    });
    expect(resolveCredentials({}, env, file)).toEqual({
      apiUrl: "http://env",
      token: "env-tok",
      source: "env",
    });
    expect(resolveCredentials({}, {}, file)).toEqual({
      apiUrl: "http://file",
      token: "file-tok",
      source: "file",
    });
  });
  test("throws with setup hint when nothing is set", () => {
    expect(() => resolveCredentials({}, {}, null)).toThrow("attach setup");
  });
});
