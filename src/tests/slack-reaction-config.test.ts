import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as otelModule from "../otel";
import {
  _reactionProvenanceSizeForTests,
  _resetBotUserIdCacheForTests,
  _resetReactionProvenanceForTests,
  ackSlackMessage,
  finalizeSlackMessageReaction,
} from "../slack/ack";
import {
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
    _resetReactionProvenanceForTests();
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

  test("finalize cleanup removes the applied reaction after a config reload post-acceptance", async () => {
    // Provenance is in-process memory only (see `acceptanceProvenance` in
    // ack.ts) -- it does NOT survive an actual server restart; the accepted
    // restart limitation is pinned by its own test below. This test covers
    // the reload-without-restart case: acceptance recorded "swarm_eyes", the
    // config then changes before finalization, and the in-memory record
    // still lets finalize find and remove the right name.
    process.env.SLACK_REACTION_ACCEPTED = "swarm_eyes";
    await ackSlackMessage(
      { reactions: { add: async () => ({ ok: true }) }, auth } as never,
      "C_RESTART_TEST",
      "1000.0012",
      "swarm_eyes",
      "accepted",
    );
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

    // Acceptance actually happened at shortcode_11 -- recorded in process
    // memory under this bot's identity.
    await ackSlackMessage(
      { reactions: { add: async () => ({ ok: true }) }, auth } as never,
      "C_CHURN_TEST",
      "1000.0013",
      "shortcode_11",
      "accepted",
    );

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
      { reactions: { add }, auth } as never,
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
    const get = async () => ({
      message: { reactions: [{ name: "swarm_eyes", users: [BOT_USER_ID] }] },
    });

    // A removal attempt only happens for a recorded, bot-owned name -- seed
    // one so this test actually reaches the failing `reactions.remove` call.
    await ackSlackMessage(
      { reactions: { add }, auth } as never,
      "C_TEST",
      "1000.0004",
      "swarm_eyes",
      "accepted",
    );

    await finalizeSlackMessageReaction(
      { reactions: { add, remove, get }, auth } as never,
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
      { reactions: { add }, auth } as never,
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
      { reactions: { add }, auth } as never,
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
      { reactions: { add: addOnAccept }, auth } as never,
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

    // A recorded applied reaction is what makes discovery consult Slack at
    // all -- with nothing recorded for this message, finalize skips
    // `reactions.get` entirely (see the empty-record guard clause).
    await ackSlackMessage(
      { reactions: { add }, auth } as never,
      "C_FULL_TEST",
      "1000.0014",
      "swarm_eyes",
      "accepted",
    );

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

    // This feature actually applied swarm_eyes at acceptance time -- that's
    // what makes it a valid removal candidate under recorded provenance.
    await ackSlackMessage(
      { reactions: { add }, auth } as never,
      "C_MULTI_TEST",
      "1000.0015",
      "swarm_eyes",
      "accepted",
    );

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

  test("finalize preserves a bot-owned reaction this feature never applied, even though the bot owns it", async () => {
    const remove = async () => ({ ok: true });
    const add = async () => ({ ok: true });
    const get = async () => ({
      message: {
        reactions: [
          { name: "swarm_eyes", users: [BOT_USER_ID] },
          // Owned by the same bot user, but applied by unrelated automation --
          // this feature never called ackSlackMessage for it, so it must not
          // be swept up by finalize's cleanup.
          { name: "thumbsup", users: [BOT_USER_ID] },
        ],
      },
    });
    const removeSpy = spyOn({ remove }, "remove");

    await ackSlackMessage(
      { reactions: { add }, auth } as never,
      "C_BOT_UNRELATED_TEST",
      "1000.0020",
      "swarm_eyes",
      "accepted",
    );

    await finalizeSlackMessageReaction(
      { reactions: { add, remove: removeSpy, get }, auth } as never,
      "C_BOT_UNRELATED_TEST",
      "1000.0020",
      "white_check_mark",
    );

    const removedNames = removeSpy.mock.calls.map((call) => (call[0] as { name: string }).name);
    expect(removedNames).toContain("swarm_eyes");
    expect(removedNames).not.toContain("thumbsup");
  });

  test("finalize's removal candidates ignore a config value that now collides with an unrelated bot-owned reaction", async () => {
    // This feature applies and records "swarm_eyes".
    process.env.SLACK_REACTION_ACCEPTED = "swarm_eyes";
    const add = async () => ({ ok: true });
    await ackSlackMessage(
      { reactions: { add }, auth } as never,
      "C_CONFIG_COLLISION_TEST",
      "1000.0024",
      "swarm_eyes",
      "accepted",
    );

    // Unrelated automation on the same bot owns "thumbsup" -- this feature
    // never called ackSlackMessage for it, so it was never recorded. Then
    // SLACK_REACTION_ACCEPTED changes to that exact name before
    // finalization: a naive implementation that seeds removal candidates
    // from the *current* configured names (rather than only this process's
    // recorded provenance) would wrongly treat "thumbsup" as removable too.
    process.env.SLACK_REACTION_ACCEPTED = "thumbsup";

    const remove = async () => ({ ok: true });
    const get = async () => ({
      message: {
        reactions: [
          { name: "swarm_eyes", users: [BOT_USER_ID] },
          { name: "thumbsup", users: [BOT_USER_ID] },
        ],
      },
    });
    const removeSpy = spyOn({ remove }, "remove");

    await finalizeSlackMessageReaction(
      { reactions: { add, remove: removeSpy, get }, auth } as never,
      "C_CONFIG_COLLISION_TEST",
      "1000.0024",
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

    await ackSlackMessage(
      { reactions: { add }, auth } as never,
      "C_INCOMPLETE_TEST",
      "1000.0016",
      "swarm_eyes",
      "accepted",
    );

    await finalizeSlackMessageReaction(
      { reactions: { add, remove: removeSpy, get }, auth } as never,
      "C_INCOMPLETE_TEST",
      "1000.0016",
      "white_check_mark",
    );

    const removedNames = removeSpy.mock.calls.map((call) => (call[0] as { name: string }).name);
    expect(removedNames).not.toContain("swarm_eyes");
  });

  test("a reactions.get failure (e.g. rate-limited) removes nothing, never a crash", async () => {
    const remove = async () => ({ ok: true });
    const add = async () => ({ ok: true });
    const get = async () => {
      throw { data: { error: "ratelimited" } };
    };
    const removeSpy = spyOn({ remove }, "remove");

    await ackSlackMessage(
      { reactions: { add }, auth } as never,
      "C_GET_FAIL_TEST",
      "1000.0017",
      "eyes",
      "accepted",
    );

    await finalizeSlackMessageReaction(
      { reactions: { add, remove: removeSpy, get }, auth } as never,
      "C_GET_FAIL_TEST",
      "1000.0017",
      "white_check_mark",
    );

    // No live discovery landed, and the configured acceptance names are
    // never a removal candidate on their own -- so nothing is removed, even
    // though this feature did record applying "eyes" earlier.
    expect(removeSpy.mock.calls).toHaveLength(0);
  });

  test("a reactions.get failure with missing_scope (reactions:read not yet granted on a pre-existing install) removes nothing, without throwing", async () => {
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

    await ackSlackMessage(
      { reactions: { add }, auth } as never,
      "C_MISSING_SCOPE_TEST",
      "1000.0019",
      "eyes",
      "accepted",
    );

    await finalizeSlackMessageReaction(
      { reactions: { add, remove: removeSpy, get }, auth } as never,
      "C_MISSING_SCOPE_TEST",
      "1000.0019",
      "white_check_mark",
    );

    // Same as any other reactions.get failure: no live discovery landed, so
    // nothing is removed, and finalization completed without throwing
    // despite the authorization failure.
    expect(removeSpy.mock.calls).toHaveLength(0);
  });

  test("when the bot's own user id can't be resolved at finalize, live discovery is skipped and nothing is removed, even with recorded acceptance", async () => {
    const remove = async () => ({ ok: true });
    const add = async () => ({ ok: true });
    const get = async () => ({
      message: { reactions: [{ name: "swarm_eyes", users: [BOT_USER_ID] }] },
    });
    const removeSpy = spyOn({ remove }, "remove");
    const getSpy = spyOn({ get }, "get");

    // Acceptance DID record swarm_eyes under a resolvable bot identity.
    await ackSlackMessage(
      { reactions: { add }, auth } as never,
      "C_NO_AUTH_TEST",
      "1000.0018",
      "swarm_eyes",
      "accepted",
    );

    const logSpy = spyOn(console, "log");
    logSpy.mockClear();
    await finalizeSlackMessageReaction(
      // No `auth` on this client at all — auth.test() can't be called.
      { reactions: { add, remove: removeSpy, get: getSpy } } as never,
      "C_NO_AUTH_TEST",
      "1000.0018",
      "white_check_mark",
    );

    // With no bot identity to match the record against, Slack is never
    // consulted and nothing is removed -- the recorded name is not enough on
    // its own.
    expect(getSpy.mock.calls).toHaveLength(0);
    expect(removeSpy.mock.calls).toHaveLength(0);
    const emitted = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(emitted).toContain("could not resolve bot user id");
  });

  test("ACCEPTED LIMITATION: provenance lost to an API restart between acknowledge and finalize means finalize removes nothing and never calls reactions.get", async () => {
    // Maintainer decision (Daniel Munoz, 2026-09-08): no DB migration, so
    // acceptance-stage provenance is process memory only. This test pins the
    // deliberate trade: after a restart the acceptance reaction stays beside
    // the terminal one, because removing a reaction this process cannot
    // prove it applied is the worse failure. `_resetReactionProvenanceForTests`
    // models the memory loss of the restart.
    process.env.SLACK_REACTION_ACCEPTED = "swarm_eyes";
    await ackSlackMessage(
      { reactions: { add: async () => ({ ok: true }) }, auth } as never,
      "C_ACTUAL_RESTART_TEST",
      "1000.0030",
      "swarm_eyes",
      "accepted",
    );
    expect(_reactionProvenanceSizeForTests()).toBe(1);

    _resetReactionProvenanceForTests();
    _resetBotUserIdCacheForTests();
    expect(_reactionProvenanceSizeForTests()).toBe(0);

    const added: string[] = [];
    const removeSpy = spyOn({ remove: async () => ({ ok: true }) }, "remove");
    const getSpy = spyOn(
      {
        get: async () => ({
          message: { reactions: [{ name: "swarm_eyes", users: [BOT_USER_ID] }] },
        }),
      },
      "get",
    );
    await finalizeSlackMessageReaction(
      {
        reactions: {
          add: async ({ name }: { name: string }) => {
            added.push(name);
            return { ok: true };
          },
          remove: removeSpy,
          get: getSpy,
        },
        auth,
      } as never,
      "C_ACTUAL_RESTART_TEST",
      "1000.0030",
      "white_check_mark",
      "completed",
    );

    expect(getSpy.mock.calls).toHaveLength(0);
    expect(removeSpy.mock.calls).toHaveLength(0);
    // The terminal outcome still lands; only the cleanup is skipped.
    expect(added).toEqual(["white_check_mark"]);
  });

  test("a finalized message releases its provenance record: N acknowledge/finalize cycles leave the store empty", async () => {
    const add = async () => ({ ok: true });
    const remove = async () => ({ ok: true });
    const get = async () => ({
      message: { reactions: [{ name: "eyes", users: [BOT_USER_ID] }] },
    });
    const client = { reactions: { add, remove, get }, auth } as never;

    const cycles = 100;
    for (let i = 0; i < cycles; i++) {
      const timestamp = `2000.${String(i).padStart(4, "0")}`;
      await ackSlackMessage(client, "C_GROWTH_TEST", timestamp, "eyes", "accepted");
      expect(_reactionProvenanceSizeForTests()).toBe(1);
      await finalizeSlackMessageReaction(
        client,
        "C_GROWTH_TEST",
        timestamp,
        "white_check_mark",
        "completed",
      );
      // The terminal write must not re-create the entry finalize just released.
      expect(_reactionProvenanceSizeForTests()).toBe(0);
    }
    expect(_reactionProvenanceSizeForTests()).toBe(0);
  });

  test("a repeated finalize preserves the terminal reaction and consults Slack only on the first pass", async () => {
    const live = new Set<string>();
    const add = async ({ name }: { name: string }) => {
      if (live.has(name)) throw { data: { error: "already_reacted" } };
      live.add(name);
      return { ok: true };
    };
    const removed: string[] = [];
    const remove = async ({ name }: { name: string }) => {
      removed.push(name);
      live.delete(name);
      return { ok: true };
    };
    const getSpy = spyOn(
      {
        get: async () => ({
          message: { reactions: [...live].map((name) => ({ name, users: [BOT_USER_ID] })) },
        }),
      },
      "get",
    );
    const client = { reactions: { add, remove, get: getSpy }, auth } as never;

    await ackSlackMessage(client, "C_REFINALIZE_TEST", "1000.0031", "eyes", "accepted");
    await finalizeSlackMessageReaction(
      client,
      "C_REFINALIZE_TEST",
      "1000.0031",
      "white_check_mark",
      "completed",
    );
    expect(removed).toEqual(["eyes"]);
    expect([...live]).toEqual(["white_check_mark"]);
    expect(getSpy.mock.calls).toHaveLength(1);

    // The watcher and the renderer can both reach a terminal message; the
    // second pass must leave white_check_mark exactly where it is.
    await finalizeSlackMessageReaction(
      client,
      "C_REFINALIZE_TEST",
      "1000.0031",
      "white_check_mark",
      "completed",
    );
    expect(removed).toEqual(["eyes"]);
    expect([...live]).toEqual(["white_check_mark"]);
    expect(getSpy.mock.calls).toHaveLength(1);
  });

  test("already_reacted with no prior record does not establish provenance: an unrelated automation's same-named reaction is never removed", async () => {
    // Unrelated automation on the same bot already owns "thumbsup". This
    // feature's configured acceptance name collides with it.
    process.env.SLACK_REACTION_ACCEPTED = "thumbsup";
    const add = async () => {
      throw { data: { error: "already_reacted" } };
    };
    await ackSlackMessage(
      { reactions: { add }, auth } as never,
      "C_ALREADY_REACTED_TEST",
      "1000.0032",
      "thumbsup",
      "accepted",
    );
    expect(_reactionProvenanceSizeForTests()).toBe(0);

    const removeSpy = spyOn({ remove: async () => ({ ok: true }) }, "remove");
    const getSpy = spyOn(
      {
        get: async () => ({
          message: { reactions: [{ name: "thumbsup", users: [BOT_USER_ID] }] },
        }),
      },
      "get",
    );
    await finalizeSlackMessageReaction(
      {
        reactions: { add: async () => ({ ok: true }), remove: removeSpy, get: getSpy },
        auth,
      } as never,
      "C_ALREADY_REACTED_TEST",
      "1000.0032",
      "white_check_mark",
      "completed",
    );

    expect(getSpy.mock.calls).toHaveLength(0);
    expect(removeSpy.mock.calls).toHaveLength(0);
  });

  test("already_reacted on a duplicate acknowledgement keeps the existing record, so finalize still removes what this feature applied", async () => {
    let addCalls = 0;
    const add = async () => {
      addCalls += 1;
      if (addCalls > 1) throw { data: { error: "already_reacted" } };
      return { ok: true };
    };
    const client = { reactions: { add }, auth } as never;
    // First delivery applies and records eyes; Slack retries the event and
    // the duplicate acknowledgement gets already_reacted.
    await ackSlackMessage(client, "C_DUP_ACK_TEST", "1000.0033", "eyes", "accepted");
    await ackSlackMessage(client, "C_DUP_ACK_TEST", "1000.0033", "eyes", "accepted");
    expect(addCalls).toBe(2);
    expect(_reactionProvenanceSizeForTests()).toBe(1);

    const removed: string[] = [];
    await finalizeSlackMessageReaction(
      {
        reactions: {
          add: async () => ({ ok: true }),
          remove: async ({ name }: { name: string }) => {
            removed.push(name);
            return { ok: true };
          },
          get: async () => ({ message: { reactions: [{ name: "eyes", users: [BOT_USER_ID] }] } }),
        },
        auth,
      } as never,
      "C_DUP_ACK_TEST",
      "1000.0033",
      "white_check_mark",
      "completed",
    );
    expect(removed).toEqual(["eyes"]);
  });

  test("provenance is bound to the bot identity that applied it: a same-message ownership handoff to another bot never removes that bot's own reaction", async () => {
    // Bot A applies and records swarm_eyes.
    const botA = { test: async () => ({ user_id: "U_BOT_A" }) };
    await ackSlackMessage(
      { reactions: { add: async () => ({ ok: true }) }, auth: botA } as never,
      "C_HANDOFF_TEST",
      "1000.0034",
      "swarm_eyes",
      "accepted",
    );

    // The client changes to bot B (SLACK_BOT_TOKEN reload). B independently
    // owns swarm_eyes on the same message for an unrelated reason. A's record
    // must not authorise deleting B's reaction.
    const removeSpy = spyOn({ remove: async () => ({ ok: true }) }, "remove");
    const getSpy = spyOn(
      {
        get: async () => ({
          message: { reactions: [{ name: "swarm_eyes", users: ["U_BOT_B"] }] },
        }),
      },
      "get",
    );
    await finalizeSlackMessageReaction(
      {
        reactions: { add: async () => ({ ok: true }), remove: removeSpy, get: getSpy },
        auth: { test: async () => ({ user_id: "U_BOT_B" }) },
      } as never,
      "C_HANDOFF_TEST",
      "1000.0034",
      "white_check_mark",
      "completed",
    );

    expect(getSpy.mock.calls).toHaveLength(0);
    expect(removeSpy.mock.calls).toHaveLength(0);
    // Finalize released the message entry; A's stale record is gone too.
    expect(_reactionProvenanceSizeForTests()).toBe(0);
  });

  test("a new client instance for the SAME bot identity (config reload without a token change) still finds the record and cleans up", async () => {
    await ackSlackMessage(
      {
        reactions: { add: async () => ({ ok: true }) },
        auth: { test: async () => ({ user_id: "U_SAME_BOT" }) },
      } as never,
      "C_SAME_BOT_RELOAD_TEST",
      "1000.0035",
      "swarm_eyes",
      "accepted",
    );

    const removed: string[] = [];
    await finalizeSlackMessageReaction(
      {
        reactions: {
          add: async () => ({ ok: true }),
          remove: async ({ name }: { name: string }) => {
            removed.push(name);
            return { ok: true };
          },
          get: async () => ({
            message: { reactions: [{ name: "swarm_eyes", users: ["U_SAME_BOT"] }] },
          }),
        },
        auth: { test: async () => ({ user_id: "U_SAME_BOT" }) },
      } as never,
      "C_SAME_BOT_RELOAD_TEST",
      "1000.0035",
      "white_check_mark",
      "completed",
    );
    expect(removed).toEqual(["swarm_eyes"]);
  });

  test("a client/token replacement (config reload) resolves the new bot user id instead of reusing the old client's", async () => {
    // src/http/core.ts replaces the Slack WebClient on every config reload.
    // A process-global cache would keep filtering with the OLD client's bot
    // user id until process restart; scoping the cache to the client
    // instance means a brand-new client always gets a fresh auth.test.
    const oldClient = {
      reactions: {
        add: async () => ({ ok: true }),
        remove: async () => ({ ok: true }),
        get: async () => ({ message: {} }),
      },
      auth: { test: async () => ({ user_id: "U_OLD_BOT" }) },
    };
    // Priming call: resolves and (in the buggy version) globally memoizes
    // U_OLD_BOT via a finalize on an unrelated message.
    await finalizeSlackMessageReaction(
      oldClient as never,
      "C_TOKEN_SWAP_TEST_OLD",
      "1000.0021",
      "white_check_mark",
    );

    // The config reloads: SLACK_BOT_TOKEN changes and a brand-new WebClient
    // is constructed. This feature applies (and records, under U_NEW_BOT) a
    // reaction through it before finalizing.
    const newClient = {
      auth: { test: async () => ({ user_id: "U_NEW_BOT" }) },
    };
    await ackSlackMessage(
      { reactions: { add: async () => ({ ok: true }) }, ...newClient } as never,
      "C_TOKEN_SWAP_TEST_NEW",
      "1000.0022",
      "new_bot_reaction",
      "accepted",
    );

    const removed: string[] = [];
    await finalizeSlackMessageReaction(
      {
        reactions: {
          add: async () => ({ ok: true }),
          remove: async ({ name }: { name: string }) => {
            removed.push(name);
            return { ok: true };
          },
          // Slack reports the reaction as owned by the NEW bot user id --
          // discovery only finds it if it resolves U_NEW_BOT for this
          // client rather than reusing the memoized U_OLD_BOT.
          get: async () => ({
            message: { reactions: [{ name: "new_bot_reaction", users: ["U_NEW_BOT"] }] },
          }),
        },
        ...newClient,
      } as never,
      "C_TOKEN_SWAP_TEST_NEW",
      "1000.0022",
      "white_check_mark",
    );

    expect(removed).toContain("new_bot_reaction");
  });
});
