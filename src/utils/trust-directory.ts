import { realpath } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { scrubSecrets } from "./secret-scrubber";

/** Every directory Claude trust pre-seeding is allowed to mark trusted. */
export const CLAUDE_TRUST_PRESEED_ROOT = "/workspace";

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/**
 * Resolve `candidate` to a canonical path and require it to live under
 * `root` (defaults to `CLAUDE_TRUST_PRESEED_ROOT`). `clonePath` (from
 * `/api/repos`, operator-set), a task's `dir` field, and a provider session's
 * `cwd` are externally-configurable strings — trusting any of them verbatim
 * would let a value like `/etc`, or a symlink that escapes the workspace,
 * suppress Claude's safety prompt for a directory the worker doesn't own.
 *
 * A path that doesn't exist yet (a repo not yet cloned) can't be
 * `realpath`-resolved directly, but naively falling back to the lexical
 * normalized string is unsafe: if an EXISTING ancestor segment is a symlink
 * that escapes `root` (e.g. `root/link` → `/etc`, with `root/link/new` not
 * yet created), the lexical path still reads as being under `root` even
 * though the real location is not. Instead, walk up to the nearest ancestor
 * that DOES exist, `realpath` that ancestor (which cannot itself have a
 * missing-leaf problem), and re-append the still-nonexistent suffix lexically
 * — that suffix has no symlinks to resolve by construction.
 */
export async function canonicalizeTrustDirectory(
  candidate: string,
  root: string = CLAUDE_TRUST_PRESEED_ROOT,
): Promise<string | null> {
  const normalized = resolvePath(candidate);
  let resolved = await realpathOrNull(normalized);
  if (resolved === null) {
    let ancestor = dirname(normalized);
    let suffix = normalized.slice(ancestor.length);
    while (true) {
      const ancestorResolved = await realpathOrNull(ancestor);
      if (ancestorResolved !== null) {
        resolved = `${ancestorResolved}${suffix}`;
        break;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        // Reached the filesystem root without finding an existing ancestor —
        // nothing to realpath through; fall back to the lexical path.
        resolved = normalized;
        break;
      }
      suffix = `${ancestor.slice(parent.length)}${suffix}`;
      ancestor = parent;
    }
  }
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    console.warn(
      scrubSecrets(
        `[claude-trust] Refusing to pre-seed trust for "${candidate}" (resolves to "${resolved}", outside ${root})`,
      ),
    );
    return null;
  }
  return resolved;
}

/**
 * Canonicalize every candidate against `root`, dropping duplicates and
 * anything that fails the root check. Used both when a session config is
 * first built and again immediately before the actual pre-seed write, since
 * a path canonicalized earlier can be replaced (symlink swap) before it's
 * used (TOCTOU) — re-validating at the point of use closes that window.
 */
export async function canonicalizeTrustDirectories(
  candidates: readonly string[],
  root: string = CLAUDE_TRUST_PRESEED_ROOT,
): Promise<string[]> {
  const resolved = await Promise.all(
    candidates.map((candidate) => canonicalizeTrustDirectory(candidate, root)),
  );
  return [...new Set(resolved.filter((dir): dir is string => dir !== null))];
}
