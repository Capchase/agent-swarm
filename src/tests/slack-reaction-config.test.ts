import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as otelModule from "../otel";
import { ackSlackMessage, finalizeSlackMessageReaction } from "../slack/ack";
import {
  _resetAcceptanceReactionHistoryForTests,
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

describe("reaction-shortcode.ts", () => {
  beforeEach(() => {
    clearReactionEnv();
    _resetAcceptanceReactionHistoryForTests();
  });
  afterEach(() => {
    clearReactionEnv();
    _resetAcceptanceReactionHistoryForTests();
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
    // the live config and the code defaults.
    process.env.SLACK_REACTION_ACCEPTED = "totally_different";

    const removed: string[] = [];
    const remove = async ({ name }: { name: string }) => {
      removed.push(name);
      if (name !== "swarm_eyes") throw { data: { error: "no_reaction" } };
    };
    const add = async () => ({ ok: true });

    await finalizeSlackMessageReaction(
      { reactions: { add, remove } } as never,
      "C_RELOAD_TEST",
      "1000.0002",
      "white_check_mark",
    );

    // The message ends clean: the reaction that was really applied got removed.
    expect(removed).toContain("swarm_eyes");
  });
});
