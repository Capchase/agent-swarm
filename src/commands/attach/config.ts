import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { getApiKey } from "../../utils/api-key";

export type AttachConfig = {
  apiUrl: string;
  token: string;
  userId?: string;
  userName?: string;
  savedAt: string;
};

const ConfigSchema = z.object({
  apiUrl: z.string().min(1),
  token: z.string().min(1),
  userId: z.string().optional(),
  userName: z.string().optional(),
  savedAt: z.string(),
});

export function configPath(env: Record<string, string | undefined> = process.env): string {
  if (env.AGENT_SWARM_CLI_CONFIG) return env.AGENT_SWARM_CLI_CONFIG;
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "agent-swarm", "cli.json");
}

export async function readConfig(path: string): Promise<AttachConfig | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`config file is not valid JSON: ${path}`);
  }
  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) throw new Error(`config file has an invalid shape: ${path}`);
  return parsed.data;
}

export async function writeConfig(path: string, cfg: AttachConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  // `mode` on writeFile does not change an existing file.
  await chmod(path, 0o600);
}

export function resolveCredentials(
  flags: { apiUrl?: string; token?: string },
  env: Record<string, string | undefined>,
  fileCfg: AttachConfig | null,
): { apiUrl: string; token: string; source: "flags" | "env" | "file" } {
  const envUrl = env.MCP_BASE_URL?.trim() ? env.MCP_BASE_URL.trim() : undefined;
  const envToken = getApiKey(env) || undefined;
  const apiUrl = flags.apiUrl || envUrl || fileCfg?.apiUrl;
  const token = flags.token || envToken || fileCfg?.token;
  if (!apiUrl || !token) {
    throw new Error(
      "No credentials. Run: agent-swarm attach setup --api-url <url> --token <aswt_...>",
    );
  }
  const source = flags.apiUrl || flags.token ? "flags" : envUrl || envToken ? "env" : "file";
  return { apiUrl: apiUrl.replace(/\/+$/, ""), token, source };
}
