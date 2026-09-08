import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as otelModule from "../otel";
import {
  _resetBotUserIdCacheForTests,
  ackSlackMessage,
  finalizeSlackMessageReaction,
} from "../slack/ack";
import {
  acceptanceReactionNames,
  normalizeSlackReactionShortcode,
  reactionName,
  SLACK_REACTION_CONFIG_KEYS,
  SLACK_REACTION_DEFAULTS,
  type SlackReactionEvent,
} from "../slack/reaction-shortcode";

const ALL_EVENTS: SlackReactionEvent[] = [
  "accepted",
  "buffered",
  "now",
  "steered",
  "completed",
  "failed",
];

function clearReactionEnv() {
  for (const key of Object.values(SLACK_REACTION_CONFIG_KEYS)) delete process.env[key];
}

const BOT_USER_ID = "U_BOT";
const auth = { test: async () => ({ user_id: BOT_USER_ID }) };

describe("reaction-shortcode.ts", () => {
  // Snapshot so this suite's env writes never leak into a later test file
  // sharing the same process (see the OTel test below, which also mutates
  // OTEL_EXPORTER_OTLP_ENDPOINT).
  const previousEnv: Record<string, string | undefined> = {
    OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  };
  for (const key of Object.values(SLACK_REACTION_CONFIG_KEYS)) {
    previousEnv[key] = process.env[key];
  }

  beforeEach(() => {
    clearReactionEnv();
    _resetBotUserIdCacheForTests();
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("reactionName returns the default for every event when env is unset", () => {
    for (const event of ALL_EVENTS) {
      expect(reactionName(event)).toBe(SLACK_REACTION_DEFAULTS[event]);
    }
  });

  test("reactionName normalizes colons, whitespace and case", () => {
    process.env.SLACK_REACTION_COMPLETED = "  :Swarm_Check_Mark:  ";
    expect(reactionName("completed")).toBe("swarm_check_mark");
  });

  test("reactionName rejects a value outside the shortcode format and returns the default", () => {
    for (const bad of ["white check", "✅", "Check!", "", "::"]) {
      process.env.SLACK_REACTION_COMPLETED = bad;
      expect(reactionName("completed")).toBe("white_check_mark");
    }
  });

  test("normalizeSlackReactionShortcode returns null for non-strings and bad values", () => {
    expect(normalizeSlackReactionShortcode(undefined)).toBeNull();
    expect(normalizeSlackReactionShortcode(42)).toBeNull();
    expect(normalizeSlackReactionShortcode("a b")).toBeNull();
    expect(normalizeSlackReactionShortcode("+1")).toBe("+1");
    expect(normalizeSlackReactionShortcode("thumbsup")).toBe("thumbsup");
    expect(normalizeSlackReactionShortcode("o'clock")).toBe("o'clock");
    expect(normalizeSlackReactionShortcode("e-mail")).toBe("e-mail");
  });

  test("normalizeSlackReactionShortcode accepts one optional ::skin-tone-[2-6] suffix", () => {
    expect(normalizeSlackReactionShortcode("thumbsup::skin-tone-6")).toBe("thumbsup::skin-tone-6");
    expect(normalizeSlackReactionShortcode(":thumbsup::skin-tone-6:")).toBe(
      "thumbsup::skin-tone-6",
    );
    expect(normalizeSlackReactionShortcode("THUMBSUP::SKIN-TONE-2")).toBe("thumbsup::skin-tone-2");
    expect(normalizeSlackReactionShortcode("+1::skin-tone-3")).toBe("+1::skin-tone-3");
  });

  test("normalizeSlackReactionShortcode rejects an out-of-range, malformed, or doubled skin-tone suffix", () => {
    expect(normalizeSlackReactionShortcode("thumbsup::skin-tone-1")).toBeNull();
    expect(normalizeSlackReactionShortcode("thumbsup::skin-tone-7")).toBeNull();
    expect(normalizeSlackReactionShortcode("thumbsup::skin-tone-")).toBeNull();
    expect(normalizeSlackReactionShortcode("thumbsup:::skin-tone-6")).toBeNull();
    expect(normalizeSlackReactionShortcode("thumbsup::skin-tone-6::skin-tone-6")).toBeNull();
  });

  test("acceptanceReactionNames returns the 4 defaults when env is unset", () => {
    expect(acceptanceReactionNames()).toEqual(["eyes", "heavy_plus_sign", "zap", "speech_balloon"]);
  });

  test("acceptanceReactionNames appends configured names after the defaults without duplicates", () => {
    process.env.SLACK_REACTION_BUFFERED = "plus_one";
    process.env.SLACK_REACTION_STEERED = "eyes";
    expect(acceptanceReactionNames()).toEqual([
      "eyes",
      "heavy_plus_sign",
      "zap",
      "speech_balloon",
      "plus_one",
    ]);
  });

  test("no Slack source file outside ack.ts names a reaction shortcode or calls reactions.add", async () => {
    const glob = new Bun.Glob("*.ts");
    const dir = new URL("../slack/", import.meta.url);
    for await (const relPath of glob.scan({ cwd: dir.pathname })) {
      if (
        relPath === "ack.ts" ||
        relPath === "reaction-shortcode.ts" ||
        relPath.endsWith(".test.ts")
      )
        continue;
      const source = await Bun.file(new URL(relPath, dir)).text();
      expect(source).not.toContain("reactions.add(");
      for (const name of Object.values(SLACK_REACTION_DEFAULTS)) {
        expect(source).not.toContain(`"${name}"`);
      }
    }
  });

  test("recordSlackReactionInvalidName is a no-op when OTel is not configured", () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    otelModule._resetOtelForTests();
    expect(otelModule.recordSlackReactionInvalidName("completed")).toBeUndefined();
  });

  test("a configured invalid name falls back to the default for every event and counts once per event", async () => {
    const spy = spyOn(otelModule, "recordSlackReactionInvalidName");
    spy.mockClear();

    for (const event of ALL_EVENTS) {
      process.env[SLACK_REACTION_CONFIG_KEYS[event]] = "not_a_real_emoji_xyz";
      const calls: Array<{ name: string }> = [];
      const add = async ({ name }: { name: string }) => {
        calls.push({ name });
        if (name === "not_a_real_emoji_xyz") throw { data: { error: "invalid_name" } };
        return { ok: true, name };
      };
      const client = { reactions: { add } };

      await ackSlackMessage(client as never, "C_TEST", "1000.0001", reactionName(event), event);

      expect(calls).toHaveLength(2);
      expect(calls[1].name).toBe(SLACK_REACTION_DEFAULTS[event]);

      delete process.env[SLACK_REACTION_CONFIG_KEYS[event]];
    }

    expect(spy).toHaveBeenCalledTimes(ALL_EVENTS.length);
  });

  test("finalize cleanup removes the applied reaction after a simulated process restart", async () => {
    // Acceptance happened under a custom shortcode in a process that no
    // longer exists — nothing in this test process ever called reactionName
    // for "accepted", so there is no in-memory trail to consult. The only
    // way to find "swarm_eyes" is to ask Slack what's really on the message.
    process.env.SLACK_REACTION_ACCEPTED = "totally_different";

    const removed: string[] = [];
    const remove = async ({ name }: { name: string }) => {
      removed.push(name);
      if (name !== "swarm_eyes") throw { data: { error: "no_reaction" } };
    };
    const add = async () => ({ ok: true });
    const get = async () => ({
      message: { reactions: [{ name: "swarm_eyes", users: [BOT_USER_ID] }] },
    });

    await finalizeSlackMessageReaction(
      { reactions: { add, remove, get }, auth } as never,
      "C_RESTART_TEST",
      "1000.0012",
      "white_check_mark",
    );

    expect(removed).toContain("swarm_eyes");
  });

  test("finalize cleanup still finds the applied reaction after many config reloads while the task was active", async () => {
    // Reconfigure "accepted" far more times than any bounded in-memory
    // history could plausibly retain.
    let acceptedName = "";
    for (let i = 0; i < 12; i++) {
      process.env.SLACK_REACTION_ACCEPTED = `shortcode_${i}`;
      acceptedName = reactionName("accepted");
    }
    expect(acceptedName).toBe("shortcode_11");

    // One more reload happens before finalization, past every name seen
    // during the churn above.
    process.env.SLACK_REACTION_ACCEPTED = "final_config_value";

    const removed: string[] = [];
    const remove = async ({ name }: { name: string }) => {
      removed.push(name);
      if (name !== "shortcode_11") throw { data: { error: "no_reaction" } };
    };
    const add = async () => ({ ok: true });
    const get = async () => ({
      message: { reactions: [{ name: "shortcode_11", users: [BOT_USER_ID] }] },
    });

    await finalizeSlackMessageReaction(
      { reactions: { add, remove, get }, auth } as never,
      "C_CHURN_TEST",
      "1000.0013",
      "white_check_mark",
    );

    expect(removed).toContain("shortcode_11");
  });

  test("a generic (non-invalid_name) add failure redacts a secret-shaped error message in the emitted log", async () => {
    const logSpy = spyOn(console, "log");
    logSpy.mockClear();
    const leaked = "github_pat_11B4WKYAA0Qe95fajGmt3o_ABCDEF1234567890abcdef";
    const add = async () => {
      throw new Error(`rate_limited: ${leaked}`);
    };
    await ackSlackMessage(
      { reactions: { add } } as never,
      "C_TEST",
      "1000.0003",
      "swarm_eyes",
      "accepted",
    );
    const emitted = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(emitted).toContain("[REDACTED:github_pat]");
    expect(emitted).not.toContain(leaked);
  });

  test("a generic (non-invalid_name/no_reaction) remove failure redacts a secret-shaped error message in the emitted log", async () => {
    const logSpy = spyOn(console, "log");
    logSpy.mockClear();
    const leaked = "github_pat_11B4WKYAA0Qe95fajGmt3o_ABCDEF1234567890abcdef";
    const remove = async () => {
      const error = new Error(`rate_limited: ${leaked}`) as Error & { data: unknown };
      error.data = { error: "rate_limited" };
      throw error;
    };
    const add = async () => ({ ok: true });
    await finalizeSlackMessageReaction(
      { reactions: { add, remove } } as never,
      "C_TEST",
      "1000.0004",
      "white_check_mark",
    );
    const emitted = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(emitted).toContain("[REDACTED:github_pat]");
    expect(emitted).not.toContain(leaked);
  });

  test("an invalid_name add failure redacts a secret-shaped reaction name in the emitted log", async () => {
    const errorSpy = spyOn(console, "error");
    errorSpy.mockClear();
    const leaked = "github_pat_11B4WKYAA0Qe95fajGmt3o_ABCDEF1234567890abcdef";
    const add = async () => {
      throw { data: { error: "invalid_name" } };
    };
    await ackSlackMessage(
      { reactions: { add } } as never,
      "C_TEST",
      "1000.0005",
      leaked,
      "accepted",
    );
    const emitted = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(emitted).toContain("[REDACTED:github_pat]");
    expect(emitted).not.toContain(leaked);
  });

  test("a fallback add failure after invalid_name redacts a secret-shaped error message in the emitted log", async () => {
    const logSpy = spyOn(console, "log");
    logSpy.mockClear();
    const leaked = "github_pat_11B4WKYAA0Qe95fajGmt3o_ABCDEF1234567890abcdef";
    const add = async ({ name }: { name: string }) => {
      if (name === "not_a_real_emoji") throw { data: { error: "invalid_name" } };
      throw new Error(`rate_limited: ${leaked}`);
    };
    await ackSlackMessage(
      { reactions: { add } } as never,
      "C_TEST",
      "1000.0006",
      "not_a_real_emoji",
      "accepted",
    );
    const emitted = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(emitted).toContain("[REDACTED:github_pat]");
    expect(emitted).not.toContain(leaked);
  });

  test("finalize cleanup removes a reaction applied under a config value the current config no longer names", async () => {
    // Acceptance happens while SLACK_REACTION_ACCEPTED names a custom shortcode.
    process.env.SLACK_REACTION_ACCEPTED = "swarm_eyes";
    const acceptedName = reactionName("accepted");
    expect(acceptedName).toBe("swarm_eyes");
    const addOnAccept = async () => ({ ok: true });
    await ackSlackMessage(
      { reactions: { add: addOnAccept } } as never,
      "C_RELOAD_TEST",
      "1000.0002",
      acceptedName,
      "accepted",
    );

    // The config reloads to a different value before the task finalizes —
    // the shortcode actually applied to the message is now unnamed by both
    // the live config and the code defaults. Only Slack's live message state
    // (queried via reactions.get) still knows what was really applied.
    process.env.SLACK_REACTION_ACCEPTED = "totally_different";

    const removed: string[] = [];
    const remove = async ({ name }: { name: string }) => {
      removed.push(name);
      if (name !== "swarm_eyes") throw { data: { error: "no_reaction" } };
    };
    const add = async () => ({ ok: true });
    const get = async () => ({
      message: { reactions: [{ name: "swarm_eyes", users: [BOT_USER_ID] }] },
    });

    await finalizeSlackMessageReaction(
      { reactions: { add, remove, get }, auth } as never,
      "C_RELOAD_TEST",
      "1000.0002",
      "white_check_mark",
    );

    // The message ends clean: the reaction that was really applied got removed.
    expect(removed).toContain("swarm_eyes");
  });

  test("discoverAppliedReactionNames requests the complete reaction list via full: true", async () => {
    const getArgs: Array<Record<string, unknown>> = [];
    const get = async (args: Record<string, unknown>) => {
      getArgs.push(args);
      return { message: { reactions: [] } };
    };
    const remove = async () => ({ ok: true });
    const add = async () => ({ ok: true });

    await finalizeSlackMessageReaction(
      { reactions: { add, remove, get }, auth } as never,
      "C_FULL_TEST",
      "1000.0014",
      "white_check_mark",
    );

    expect(getArgs).toHaveLength(1);
    expect(getArgs[0].full).toBe(true);
  });

  test("finalize only attempts removal for reactions this bot owns, never a human's", async () => {
    const remove = async () => ({ ok: true });
    const add = async () => ({ ok: true });
    const get = async () => ({
      message: {
        reactions: [
          { name: "swarm_eyes", users: [BOT_USER_ID] },
          { name: "thumbsup", users: ["U_HUMAN"] },
        ],
      },
    });
    const removeSpy = spyOn({ remove }, "remove");

    await finalizeSlackMessageReaction(
      { reactions: { add, remove: removeSpy, get }, auth } as never,
      "C_MULTI_TEST",
      "1000.0015",
      "white_check_mark",
    );

    const removedNames = removeSpy.mock.calls.map((call) => (call[0] as { name: string }).name);
    expect(removedNames).toContain("swarm_eyes");
    expect(removedNames).not.toContain("thumbsup");
  });

  test("a reaction entry missing users (an incomplete/default response) is never treated as bot-owned", async () => {
    const remove = async () => ({ ok: true });
    const add = async () => ({ ok: true });
    const get = async () => ({
      message: { reactions: [{ name: "swarm_eyes" }] }, // no `users` field
    });
    const removeSpy = spyOn({ remove }, "remove");

    await finalizeSlackMessageReaction(
      { reactions: { add, remove: removeSpy, get }, auth } as never,
      "C_INCOMPLETE_TEST",
      "1000.0016",
      "white_check_mark",
    );

    const removedNames = removeSpy.mock.calls.map((call) => (call[0] as { name: string }).name);
    expect(removedNames).not.toContain("swarm_eyes");
  });

  test("a reactions.get failure (e.g. rate-limited) falls back to the configured acceptance names only", async () => {
    const remove = async () => ({ ok: true });
    const add = async () => ({ ok: true });
    const get = async () => {
      throw { data: { error: "ratelimited" } };
    };
    const removeSpy = spyOn({ remove }, "remove");

    await finalizeSlackMessageReaction(
      { reactions: { add, remove: removeSpy, get }, auth } as never,
      "C_GET_FAIL_TEST",
      "1000.0017",
      "white_check_mark",
    );

    // No live discovery landed, so only the code-default acceptance names
    // (accepted/buffered/now/steered) were attempted — never a crash.
    const removedNames = removeSpy.mock.calls.map((call) => (call[0] as { name: string }).name);
    expect(removedNames.sort()).toEqual(
      ["eyes", "heavy_plus_sign", "zap", "speech_balloon"].sort(),
    );
  });

  test("a reactions.get failure with missing_scope (reactions:read not yet granted on a pre-existing install) falls back to the configured acceptance names only, without throwing", async () => {
    const remove = async () => ({ ok: true });
    const add = async () => ({ ok: true });
    const get = async () => {
      // Shape thrown by the Slack SDK for a scope the app was never granted —
      // distinct from `ratelimited` above: this failure is permanent until
      // the app is reinstalled with the `reactions:read` scope (see
      // DEPLOYMENT.md), not transient.
      throw { data: { ok: false, error: "missing_scope", needed: "reactions:read" } };
    };
    const removeSpy = spyOn({ remove }, "remove");

    await finalizeSlackMessageReaction(
      { reactions: { add, remove: removeSpy, get }, auth } as never,
      "C_MISSING_SCOPE_TEST",
      "1000.0019",
      "white_check_mark",
    );

    // Same fallback as any other reactions.get failure: only the code-default
    // acceptance names were attempted, and finalization completed without
    // throwing despite the authorization failure.
    const removedNames = removeSpy.mock.calls.map((call) => (call[0] as { name: string }).name);
    expect(removedNames.sort()).toEqual(
      ["eyes", "heavy_plus_sign", "zap", "speech_balloon"].sort(),
    );
  });

  test("when the bot's own user id can't be resolved, live discovery is skipped and only configured names are removed", async () => {
    const logSpy = spyOn(console, "log");
    logSpy.mockClear();
    const remove = async () => ({ ok: true });
    const add = async () => ({ ok: true });
    const get = async () => ({
      message: { reactions: [{ name: "some_stray_reaction", users: ["U_HUMAN"] }] },
    });
    const removeSpy = spyOn({ remove }, "remove");

    await finalizeSlackMessageReaction(
      // No `auth` on this client at all — auth.test() can't be called.
      { reactions: { add, remove: removeSpy, get } } as never,
      "C_NO_AUTH_TEST",
      "1000.0018",
      "white_check_mark",
    );

    const removedNames = removeSpy.mock.calls.map((call) => (call[0] as { name: string }).name);
    expect(removedNames).not.toContain("some_stray_reaction");
    const emitted = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(emitted).toContain("could not resolve bot user id");
  });
});
