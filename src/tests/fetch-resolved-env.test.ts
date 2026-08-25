import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  applyResolvedEnvToProcessEnv,
  BOOT_ENV_SNAPSHOT,
  fetchResolvedEnv,
  RELOADABLE_ENV_KEYS,
} from "../commands/runner";

/**
 * Tests for the fetchResolvedEnv() / applyResolvedEnvToProcessEnv() behavior
 * used in runner.ts, exercised against the real (exported) implementations
 * rather than a hand-maintained replica — see issue #1102 bug 2, where a
 * replica of this exact logic could pass while the real implementation
 * silently cleared a container-provided value.
 */

let server: ReturnType<typeof Bun.serve>;
let testUrl: string;

/** `rawBody`, when set, is sent verbatim (bypassing JSON.stringify) so a test can simulate a truly malformed response body. */
type MockResponse = { status: number; body: unknown; rawBody?: string };

const defaultMockResponse: MockResponse = {
  status: 200,
  body: { configs: [] },
};
const mockResponsesByAgentId = new Map<string, MockResponse>();

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/config/resolved") {
        const agentId = url.searchParams.get("agentId") ?? "";
        const mockResponse = mockResponsesByAgentId.get(agentId) ?? defaultMockResponse;
        return new Response(mockResponse.rawBody ?? JSON.stringify(mockResponse.body), {
          status: mockResponse.status,
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

describe("fetchResolvedEnv", () => {
  test("returns baseEnv when apiUrl is empty", async () => {
    const baseEnv = { EXISTING: "value" };
    const result = await fetchResolvedEnv("", "key", "agent-1", baseEnv);
    expect(result.env).toEqual({ EXISTING: "value" });
  });

  test("returns baseEnv when agentId is empty", async () => {
    const baseEnv = { EXISTING: "value" };
    const result = await fetchResolvedEnv(testUrl, "key", "", baseEnv);
    expect(result.env).toEqual({ EXISTING: "value" });
  });

  test("merges API config over baseEnv", async () => {
    const agentId = "agent-merge";
    mockResponsesByAgentId.set(agentId, {
      status: 200,
      body: {
        configs: [
          { key: "NEW_VAR", value: "from-api" },
          { key: "OVERRIDE_VAR", value: "api-wins" },
        ],
      },
    });

    const baseEnv = { EXISTING: "keep", OVERRIDE_VAR: "original" };
    const result = await fetchResolvedEnv(testUrl, "key", agentId, baseEnv);

    expect(result.env.EXISTING).toBe("keep");
    expect(result.env.NEW_VAR).toBe("from-api");
    expect(result.env.OVERRIDE_VAR).toBe("api-wins");
  });

  test("returns baseEnv when API returns empty configs", async () => {
    const agentId = "agent-empty";
    mockResponsesByAgentId.set(agentId, { status: 200, body: { configs: [] } });

    const baseEnv = { EXISTING: "value" };
    const result = await fetchResolvedEnv(testUrl, "key", agentId, baseEnv);
    expect(result.env).toEqual({ EXISTING: "value" });
  });

  test("returns baseEnv when API returns non-200", async () => {
    const agentId = "agent-500";
    mockResponsesByAgentId.set(agentId, { status: 500, body: { error: "server error" } });

    const baseEnv = { EXISTING: "value" };
    const result = await fetchResolvedEnv(testUrl, "key", agentId, baseEnv);
    expect(result.env).toEqual({ EXISTING: "value" });
  });

  test("returns baseEnv when API is unreachable", async () => {
    const baseEnv = { EXISTING: "value" };
    const result = await fetchResolvedEnv("http://localhost:19999", "key", "agent-1", baseEnv);
    expect(result.env).toEqual({ EXISTING: "value" });
  });

  // ─── Non-authoritative config-fetch regression ──────────────────────────
  //
  // `configuredReloadableKeys` must be `undefined` — not an empty Set — on
  // every failure path, so `applyResolvedEnvToProcessEnv` treats "the fetch
  // failed" the same as "don't touch anything" rather than "every
  // reloadable key's row was deleted". An empty Set here previously read as
  // the latter and reset every live operator setting (e.g.
  // CLAUDE_TRUST_PRESEED) back to the boot baseline on a transient outage.

  test("configuredReloadableKeys is undefined (non-authoritative) on a non-200 response", async () => {
    const agentId = "agent-500-reloadable";
    mockResponsesByAgentId.set(agentId, { status: 500, body: { error: "server error" } });

    const result = await fetchResolvedEnv(testUrl, "key", agentId, {});
    expect(result.configuredReloadableKeys).toBeUndefined();
  });

  test("configuredReloadableKeys is undefined (non-authoritative) when the API is unreachable", async () => {
    const result = await fetchResolvedEnv("http://localhost:19999", "key", "agent-1", {});
    expect(result.configuredReloadableKeys).toBeUndefined();
  });

  test("configuredReloadableKeys is undefined (non-authoritative) when the response body isn't valid JSON", async () => {
    const agentId = "agent-bad-json";
    mockResponsesByAgentId.set(agentId, {
      status: 200,
      body: undefined,
      rawBody: "{ this is not valid json",
    });

    const result = await fetchResolvedEnv(testUrl, "key", agentId, {});
    expect(result.configuredReloadableKeys).toBeUndefined();
  });

  test("configuredReloadableKeys is a (possibly empty) Set on an authoritative 200 with no configs", async () => {
    const agentId = "agent-authoritative-empty";
    mockResponsesByAgentId.set(agentId, { status: 200, body: { configs: [] } });

    const result = await fetchResolvedEnv(testUrl, "key", agentId, {});
    expect(result.configuredReloadableKeys).toBeDefined();
    expect(result.configuredReloadableKeys?.size).toBe(0);
  });

  test("does not mutate the baseEnv object", async () => {
    const agentId = "agent-mutation";
    mockResponsesByAgentId.set(agentId, {
      status: 200,
      body: { configs: [{ key: "NEW_VAR", value: "new" }] },
    });

    const baseEnv = { EXISTING: "value" };
    const result = await fetchResolvedEnv(testUrl, "key", agentId, baseEnv);

    // baseEnv should be untouched
    expect(baseEnv).toEqual({ EXISTING: "value" });
    expect(result.env.NEW_VAR).toBe("new");
  });

  test("handles multiple configs correctly", async () => {
    const agentId = "agent-multiple";
    mockResponsesByAgentId.set(agentId, {
      status: 200,
      body: {
        configs: [
          { key: "VAR_A", value: "a" },
          { key: "VAR_B", value: "b" },
          { key: "VAR_C", value: "c" },
        ],
      },
    });

    const result = await fetchResolvedEnv(testUrl, "key", agentId, {});
    expect(result.env.VAR_A).toBe("a");
    expect(result.env.VAR_B).toBe("b");
    expect(result.env.VAR_C).toBe("c");
  });

  // ─── Issue #1102 bug 2 regression coverage ──────────────────────────────
  //
  // A container-provided value for a model-control key (MODEL_OVERRIDE,
  // REASONING_EFFORT_OVERRIDE — e.g. `docker run -e MODEL_OVERRIDE=...`)
  // must survive a config reload even when swarm_config holds a BLANK row
  // for that key. Nothing writes an intentionally-empty row through the
  // dedicated tri-state endpoint (it DELETEs to clear — see
  // `updateAgentRuntimeRoute` in src/http/agents.ts), so a blank row can
  // only be a stray write via the generic `PUT /api/config` (which accepts
  // `value: z.unknown()`); treating it the same as "no row" for these keys
  // closes that gap.
  //
  // This protection is intentionally narrower than the full
  // RELOADABLE_ENV_KEYS set: other reloadable keys (MEMORY_RATERS,
  // SLACK_DISABLE, etc.) are written through the generic config-page path,
  // where a blank row IS a meaningful, intentional value an operator can
  // set on purpose (e.g. `MEMORY_RATERS=""` is the documented way to run no
  // raters even when the container sets `MEMORY_RATERS=llm` — see
  // getRegisteredRaters in src/be/memory/raters/registry.ts). Guarding
  // those too would silently ignore a real operator override.

  test("a blank swarm_config value for MODEL_OVERRIDE does not clear the container-provided value", async () => {
    expect(RELOADABLE_ENV_KEYS.has("MODEL_OVERRIDE")).toBe(true);

    const agentId = "agent-blank-model-override";
    mockResponsesByAgentId.set(agentId, {
      status: 200,
      body: { configs: [{ key: "MODEL_OVERRIDE", value: "" }] },
    });

    const baseEnv = { MODEL_OVERRIDE: "openrouter/deepseek/deepseek-v4-flash" };
    const result = await fetchResolvedEnv(testUrl, "key", agentId, baseEnv);

    expect(result.env.MODEL_OVERRIDE).toBe("openrouter/deepseek/deepseek-v4-flash");
  });

  test("a blank swarm_config value for a non-reloadable key still overrides baseEnv (unchanged behavior)", async () => {
    const agentId = "agent-blank-nonreloadable";
    mockResponsesByAgentId.set(agentId, {
      status: 200,
      body: { configs: [{ key: "SOME_OTHER_VAR", value: "" }] },
    });

    const baseEnv = { SOME_OTHER_VAR: "container-value" };
    const result = await fetchResolvedEnv(testUrl, "key", agentId, baseEnv);

    // Only the RELOADABLE_ENV_KEYS floor is protected — every other config
    // key keeps today's "config store always wins" behavior.
    expect(result.env.SOME_OTHER_VAR).toBe("");
  });

  test("an explicit non-empty swarm_config value still overrides MODEL_OVERRIDE", async () => {
    const agentId = "agent-explicit-model-override";
    mockResponsesByAgentId.set(agentId, {
      status: 200,
      body: { configs: [{ key: "MODEL_OVERRIDE", value: "operator/explicit-model" }] },
    });

    const baseEnv = { MODEL_OVERRIDE: "container-value" };
    const result = await fetchResolvedEnv(testUrl, "key", agentId, baseEnv);

    expect(result.env.MODEL_OVERRIDE).toBe("operator/explicit-model");
  });

  test("a blank swarm_config value sets MODEL_OVERRIDE when there was no container value", async () => {
    const agentId = "agent-blank-no-base";
    mockResponsesByAgentId.set(agentId, {
      status: 200,
      body: { configs: [{ key: "MODEL_OVERRIDE", value: "" }] },
    });

    const result = await fetchResolvedEnv(testUrl, "key", agentId, {});

    expect(result.env.MODEL_OVERRIDE).toBe("");
  });

  test("a blank swarm_config value for REASONING_EFFORT_OVERRIDE does not clear the container-provided value", async () => {
    expect(RELOADABLE_ENV_KEYS.has("REASONING_EFFORT_OVERRIDE")).toBe(true);

    const agentId = "agent-blank-reasoning-effort";
    mockResponsesByAgentId.set(agentId, {
      status: 200,
      body: { configs: [{ key: "REASONING_EFFORT_OVERRIDE", value: "" }] },
    });

    const baseEnv = { REASONING_EFFORT_OVERRIDE: "high" };
    const result = await fetchResolvedEnv(testUrl, "key", agentId, baseEnv);

    expect(result.env.REASONING_EFFORT_OVERRIDE).toBe("high");
  });

  test("a blank swarm_config value for MEMORY_RATERS clears the container-provided value (disable-all-raters is a real, intentional operator state)", async () => {
    expect(RELOADABLE_ENV_KEYS.has("MEMORY_RATERS")).toBe(true);

    const agentId = "agent-blank-memory-raters";
    mockResponsesByAgentId.set(agentId, {
      status: 200,
      body: { configs: [{ key: "MEMORY_RATERS", value: "" }] },
    });

    // Container sets MEMORY_RATERS=llm; an operator explicitly saving a
    // blank value on the dashboard's Configuration page must be able to
    // turn raters off, not have the container value silently win.
    const baseEnv = { MEMORY_RATERS: "llm" };
    const result = await fetchResolvedEnv(testUrl, "key", agentId, baseEnv);

    expect(result.env.MEMORY_RATERS).toBe("");
  });
});

describe("applyResolvedEnvToProcessEnv", () => {
  const savedValues = new Map<string, string | undefined>();

  afterEach(() => {
    for (const [key, value] of savedValues) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    savedValues.clear();
  });

  function snapshot(key: string) {
    if (!savedValues.has(key)) savedValues.set(key, process.env[key]);
  }

  test("does not clear process.env when freshEnv omits a reloadable key", () => {
    snapshot("MODEL_OVERRIDE");
    process.env.MODEL_OVERRIDE = "container-value";

    const changed = applyResolvedEnvToProcessEnv({});

    expect(changed).not.toContain("MODEL_OVERRIDE");
    expect(process.env.MODEL_OVERRIDE).toBe("container-value");
  });

  test("applies an explicit non-empty value for a reloadable key", () => {
    snapshot("MODEL_OVERRIDE");
    process.env.MODEL_OVERRIDE = "old-value";

    const changed = applyResolvedEnvToProcessEnv({ MODEL_OVERRIDE: "new-value" });

    expect(changed).toContain("MODEL_OVERRIDE");
    expect(process.env.MODEL_OVERRIDE).toBe("new-value");
  });

  // ─── CLAUDE_TRUST_PRESEED reset-precedence regression ───────────────────
  //
  // Without `configuredReloadableKeys`, a stored `false` for a
  // RELOADABLE_ENV_KEYS entry survived its own swarm_config row deletion: the
  // next `fetchResolvedEnv(..., process.env, ...)` copied the *live*
  // (already-mutated) process.env as its base, so a deleted row resolved to
  // "whatever the last reload wrote" instead of the boot/default value. See
  // BOOT_ENV_SNAPSHOT + the `configuredReloadableKeys` param.

  test("a key that drops out of configuredReloadableKeys is restored to the boot baseline, not left stuck", () => {
    snapshot("SLACK_DISABLE");
    // Round 1: a swarm_config row sets a value distinct from the real boot
    // baseline (whatever the environment provides — deliberately not
    // asserted as unset, since a dev/CI environment may set this key).
    const bootValue = BOOT_ENV_SNAPSHOT.SLACK_DISABLE;
    const configuredValue = bootValue === "true" ? "false" : "true";
    applyResolvedEnvToProcessEnv({ SLACK_DISABLE: configuredValue }, new Set(["SLACK_DISABLE"]));
    expect(process.env.SLACK_DISABLE).toBe(configuredValue);

    // Round 2: the row is gone (UI "Reset") — freshEnv still carries the
    // stale value in the plain object (mirrors fetchResolvedEnv spreading
    // baseEnv), but configuredReloadableKeys no longer lists the key.
    const changed = applyResolvedEnvToProcessEnv({ SLACK_DISABLE: configuredValue }, new Set());

    expect(changed).toContain("SLACK_DISABLE");
    expect(process.env.SLACK_DISABLE).toBe(bootValue);
  });

  test("omitting configuredReloadableKeys never restores anything (back-compat with the two tests above)", () => {
    snapshot("SLACK_DISABLE");
    process.env.SLACK_DISABLE = "true";

    const changed = applyResolvedEnvToProcessEnv({ SLACK_DISABLE: "true" });

    expect(changed).toEqual([]);
    expect(process.env.SLACK_DISABLE).toBe("true");
  });
});

describe("fetchResolvedEnv + applyResolvedEnvToProcessEnv — CLAUDE_TRUST_PRESEED reset end-to-end", () => {
  const savedValue = process.env.CLAUDE_TRUST_PRESEED;

  afterEach(() => {
    if (savedValue === undefined) {
      delete process.env.CLAUDE_TRUST_PRESEED;
    } else {
      process.env.CLAUDE_TRUST_PRESEED = savedValue;
    }
  });

  test("false -> reset restores the boot baseline instead of staying stuck at false", async () => {
    expect(RELOADABLE_ENV_KEYS.has("CLAUDE_TRUST_PRESEED")).toBe(true);
    delete process.env.CLAUDE_TRUST_PRESEED; // boot baseline: unset (documented default: true)

    const agentId = "agent-trust-preseed-reset";

    // Step 1: an operator sets CLAUDE_TRUST_PRESEED=false via swarm_config,
    // and the runner applies it live.
    mockResponsesByAgentId.set(agentId, {
      status: 200,
      body: { configs: [{ key: "CLAUDE_TRUST_PRESEED", value: "false" }] },
    });
    const first = await fetchResolvedEnv(testUrl, "key", agentId);
    expect(first.configuredReloadableKeys.has("CLAUDE_TRUST_PRESEED")).toBe(true);
    applyResolvedEnvToProcessEnv(first.env, first.configuredReloadableKeys);
    expect(process.env.CLAUDE_TRUST_PRESEED).toBe("false");

    // Step 2: the operator clicks "Reset" — the row is deleted — and the
    // next reload runs.
    mockResponsesByAgentId.set(agentId, { status: 200, body: { configs: [] } });
    const second = await fetchResolvedEnv(testUrl, "key", agentId);
    expect(second.configuredReloadableKeys.has("CLAUDE_TRUST_PRESEED")).toBe(false);
    applyResolvedEnvToProcessEnv(second.env, second.configuredReloadableKeys);

    // Restored to the boot baseline (unset here — worker falls back to the
    // documented default, true), not stuck at the deleted row's last value.
    expect(process.env.CLAUDE_TRUST_PRESEED).toBeUndefined();
  });

  test("a transient config-fetch failure does NOT reset a previously-configured value", async () => {
    delete process.env.CLAUDE_TRUST_PRESEED; // boot baseline: unset (documented default: true)

    const agentId = "agent-trust-preseed-transient-failure";

    // Step 1: an operator sets CLAUDE_TRUST_PRESEED=false via swarm_config,
    // and the runner applies it live — same as the happy-path test above.
    mockResponsesByAgentId.set(agentId, {
      status: 200,
      body: { configs: [{ key: "CLAUDE_TRUST_PRESEED", value: "false" }] },
    });
    const first = await fetchResolvedEnv(testUrl, "key", agentId);
    applyResolvedEnvToProcessEnv(first.env, first.configuredReloadableKeys);
    expect(process.env.CLAUDE_TRUST_PRESEED).toBe("false");

    // Step 2: the config API has a transient outage on the next reload — the
    // row was never deleted, the fetch just failed this round.
    mockResponsesByAgentId.set(agentId, { status: 503, body: { error: "unavailable" } });
    const second = await fetchResolvedEnv(testUrl, "key", agentId, process.env);
    expect(second.configuredReloadableKeys).toBeUndefined();
    applyResolvedEnvToProcessEnv(second.env, second.configuredReloadableKeys);

    // The live value must survive the outage — a reset here would silently
    // re-enable the trust dialog (CLAUDE_TRUST_PRESEED back to the true
    // default) until the next successful reload.
    expect(process.env.CLAUDE_TRUST_PRESEED).toBe("false");
  });
});
