/**
 * Filesystem helpers for materialising ~/.codex/auth.json from the credential
 * pool. Uses an atomic write (tmp → rename) so a concurrent read never sees a
 * partial file, which would break the Codex CLI's auth bootstrap.
 */

import os from "node:os";
import { join } from "node:path";
import { credentialsToAuthJson } from "./auth-json.js";
import type { CodexOAuthCredentials } from "./types.js";

/**
 * Atomically write `~/.codex/auth.json` from `creds` for the given slot.
 *
 * Write order: mkdir → write .tmp → rename (atomic on POSIX). The `slot`
 * parameter is unused at the FS level — the file is always `auth.json` —
 * but it is kept in the signature so callers can clearly state which pool
 * slot they are materialising (aids logging and tests).
 */
export async function materializeCodexAuthJson(
  _slot: number,
  creds: CodexOAuthCredentials,
  deps: {
    homedir?: () => string;
    fs?: {
      mkdir: (
        path: string,
        opts: { recursive: boolean; mode: number },
      ) => Promise<string | undefined>;
      writeFile: (path: string, data: string, opts: { mode: number }) => Promise<void>;
      rename: (from: string, to: string) => Promise<void>;
    };
  } = {},
): Promise<void> {
  const fsModule = await import("node:fs/promises");
  const homedir = deps.homedir ?? os.homedir.bind(os);
  const fs = deps.fs ?? {
    mkdir: (path: string, opts: { recursive: boolean; mode: number }) => fsModule.mkdir(path, opts),
    writeFile: (path: string, data: string, opts: { mode: number }) =>
      fsModule.writeFile(path, data, opts),
    rename: (from: string, to: string) => fsModule.rename(from, to),
  };

  const codexDir = join(homedir(), ".codex");
  const authJsonPath = join(codexDir, "auth.json");
  const tmpPath = join(codexDir, "auth.json.tmp");

  await fs.mkdir(codexDir, { recursive: true, mode: 0o700 });
  const authJson = credentialsToAuthJson(creds);
  await fs.writeFile(tmpPath, JSON.stringify(authJson, null, 2), { mode: 0o600 });
  await fs.rename(tmpPath, authJsonPath);
}
