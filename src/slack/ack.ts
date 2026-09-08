import type { WebClient } from "@slack/web-api";
import { getLogsByTaskIdChronological, getSlackTasksInThread } from "../be/db";
import { recordSlackReactionInvalidName } from "../otel";
import { type AgentTask, isTerminalTaskStatus } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { getSlackApp } from "./app";
import {
  reactionName,
  SLACK_REACTION_CONFIG_KEYS,
  SLACK_REACTION_DEFAULTS,
  type SlackReactionEvent,
} from "./reaction-shortcode";

export { reactionName, type SlackReactionEvent } from "./reaction-shortcode";

type SlackReactionClient = Pick<WebClient, "reactions" | "auth">;

function slackErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const data = "data" in error ? error.data : undefined;
  if (!data || typeof data !== "object" || !("error" in data)) return undefined;
  return typeof data.error === "string" ? data.error : undefined;
}

// Keyed by client instance, not process-global: `src/http/core.ts` replaces
// the Slack `WebClient` whenever config reloads (e.g. `SLACK_BOT_TOKEN`
// changes), and a process-global cache would keep filtering discovery with
// the *previous* client's bot user id until restart. A WeakMap scopes the
// memoized id to the exact client that resolved it, so a client/token swap
// naturally gets a fresh lookup. Only a resolved id is memoized so a
// transient auth.test failure is retried rather than permanently disabling
// discovery.
let botUserIdCache = new WeakMap<SlackReactionClient, string>();

async function getBotUserId(client: SlackReactionClient): Promise<string | null> {
  const cached = botUserIdCache.get(client);
  if (cached) return cached;
  try {
    const result = await client.auth?.test();
    const userId = typeof result?.user_id === "string" ? result.user_id : null;
    if (userId) botUserIdCache.set(client, userId);
    return userId;
  } catch {
    return null;
  }
}

/** Test-only: clear the memoized bot user id so each test controls its own auth.test mock. */
export function _resetBotUserIdCacheForTests(): void {
  botUserIdCache = new WeakMap();
}

/**
 * Which reaction names THIS process applied to a given message, keyed by
 * `${channel}:${timestamp}`. In-memory only -- deliberately not persisted.
 * A restart mid-task loses the record for any message that hadn't finalized
 * yet, so cleanup removes nothing for it: leaving a stale reaction behind is
 * the correct trade against deleting a reaction this feature never applied.
 * Entries are deleted at finalize (see `finalizeSlackMessageReaction`) so
 * the map cannot grow without bound.
 */
const appliedReactionsByMessage = new Map<string, Set<string>>();

function messageKey(channel: string, timestamp: string): string {
  return `${channel}:${timestamp}`;
}

/**
 * Ask Slack which reaction names this bot currently has on the message, then
 * narrow that list to only the names this process recorded (in
 * `appliedReactionsByMessage`) as ones this feature actually applied.
 *
 * `full: true` is required for Slack to return the complete reaction list,
 * and each candidate is checked against the bot's own user id (from
 * `auth.test`) so a human's reaction never triggers a needless
 * `reactions.remove` call. The bot-owned check alone is not a sufficient
 * discriminator: the same bot user may own a reaction this feature never
 * applied (added by unrelated automation), and that reaction must never be
 * swept up. Intersecting live bot-owned names with this process's own
 * provenance record is what makes cleanup precise across any number of
 * config reloads between acceptance and finalization -- the record tracks
 * exactly what THIS feature applied, independent of the live config.
 *
 * If the bot's own user id can't be resolved, live discovery is skipped
 * entirely (rather than falling back to trial-removing every returned name).
 */
async function discoverAppliedReactionNames(
  client: SlackReactionClient,
  channel: string,
  timestamp: string,
): Promise<string[]> {
  const botUserId = await getBotUserId(client);
  if (!botUserId) {
    console.log(
      scrubSecrets(
        "[Slack] could not resolve bot user id via auth.test; skipping live reaction discovery and relying on configured reaction names only",
      ),
    );
    return [];
  }
  const appliedByThisFeature = appliedReactionsByMessage.get(messageKey(channel, timestamp));
  if (!appliedByThisFeature || appliedByThisFeature.size === 0) return [];
  try {
    const result = await client.reactions.get({ channel, timestamp, full: true });
    return (result.message?.reactions ?? [])
      .filter((reaction) => reaction.users?.includes(botUserId))
      .map((reaction) => reaction.name)
      .filter((name): name is string => typeof name === "string")
      .filter((name) => appliedByThisFeature.has(name));
  } catch {
    return [];
  }
}

/** Record that this feature applied `name` to `channel`/`timestamp`, so
 * finalize's cleanup knows this exact name is a removal candidate for this
 * message (see `discoverAppliedReactionNames`). */
function trackAppliedReaction(channel: string, timestamp: string, name: string): void {
  const key = messageKey(channel, timestamp);
  let names = appliedReactionsByMessage.get(key);
  if (!names) {
    names = new Set();
    appliedReactionsByMessage.set(key, names);
  }
  names.add(name);
}

/**
 * Acknowledge that the swarm accepted a Slack message.
 *
 * Reactions are best-effort feedback only: Slack API failures must never block
 * message ingestion or task creation. Slack reports repeated acknowledgements
 * as `already_reacted`, which is an expected no-op.
 */
export async function ackSlackMessage(
  client: SlackReactionClient,
  channel: string,
  timestamp: string,
  name: string,
  event?: SlackReactionEvent,
): Promise<void> {
  try {
    await client.reactions.add({ channel, name, timestamp });
    trackAppliedReaction(channel, timestamp, name);
  } catch (error) {
    if (slackErrorCode(error) === "already_reacted") {
      trackAppliedReaction(channel, timestamp, name);
      return;
    }
    if (slackErrorCode(error) === "invalid_name") {
      const keyLabel = event ? SLACK_REACTION_CONFIG_KEYS[event] : "the SLACK_REACTION_* key";
      console.error(
        scrubSecrets(
          `[Slack] reaction "${name}" for event ${event ?? "unknown"} rejected by Slack (invalid_name); check ${keyLabel}`,
        ),
      );
      recordSlackReactionInvalidName(event ?? "unknown");
      // Always attempt the one default fallback, even when the rejected name
      // already equals it (Slack's rejection isn't assumed to be permanent)
      // and even when `event` is unknown (fall back to a universally-valid
      // built-in reaction rather than leaving the message with none at all).
      const fallback = event ? SLACK_REACTION_DEFAULTS[event] : SLACK_REACTION_DEFAULTS.completed;
      try {
        await client.reactions.add({ channel, name: fallback, timestamp });
        trackAppliedReaction(channel, timestamp, fallback);
      } catch (fallbackError) {
        console.log(
          scrubSecrets(
            `[Slack] ${fallback} acknowledgement reaction failed: ${fallbackError instanceof Error ? fallbackError.message : fallbackError}`,
          ),
        );
      }
      return;
    }
    console.log(
      scrubSecrets(
        `[Slack] ${name} acknowledgement reaction failed: ${error instanceof Error ? error.message : error}`,
      ),
    );
  }
}

/**
 * Replace this bot's acceptance reaction with the terminal task outcome.
 *
 * The removal candidate set is exactly this process's recorded
 * applied-reaction names intersected with the bot's live reactions on the
 * message (`discoverAppliedReactionNames`) -- never the currently configured
 * acceptance names on their own. A configured name is not, by itself, proof
 * this feature ever applied it: `SLACK_REACTION_ACCEPTED` could change
 * between acceptance and finalization to a name some unrelated automation
 * already owns on this bot, and that reaction must never be swept up.
 */
export async function finalizeSlackMessageReaction(
  client: SlackReactionClient,
  channel: string,
  timestamp: string,
  outcome: string,
  event?: SlackReactionEvent,
): Promise<void> {
  const candidateNames = await discoverAppliedReactionNames(client, channel, timestamp);

  for (const name of candidateNames) {
    try {
      await client.reactions.remove({ channel, name, timestamp });
    } catch (error) {
      const code = slackErrorCode(error);
      if (code === "no_reaction" || code === "message_not_found" || code === "invalid_name")
        continue;
      console.log(
        scrubSecrets(
          `[Slack] ${name} acknowledgement reaction removal failed: ${error instanceof Error ? error.message : error}`,
        ),
      );
    }
  }

  // This message's provenance is only needed for one finalize pass; clear it
  // so the map can't grow without bound.
  appliedReactionsByMessage.delete(messageKey(channel, timestamp));

  await ackSlackMessage(client, channel, timestamp, outcome, event);
}

export async function finalizeTerminalSlackReactions(tasks: AgentTask[]): Promise<void> {
  const app = getSlackApp();
  if (!app) return;

  const triggers = new Map<string, { channelId: string; threadTs: string; timestamp: string }>();
  for (const task of tasks) {
    if (!task.slackChannelId || !task.slackThreadTs || !task.slackTriggerMessageTs) continue;
    const key = `${task.slackChannelId}\0${task.slackTriggerMessageTs}`;
    triggers.set(key, {
      channelId: task.slackChannelId,
      threadTs: task.slackThreadTs,
      timestamp: task.slackTriggerMessageTs,
    });
  }

  for (const { channelId, threadTs, timestamp } of triggers.values()) {
    const linkedTasks = (await getSlackTasksInThread(channelId, threadTs)).filter(
      (task) => task.slackTriggerMessageTs === timestamp,
    );
    if (
      linkedTasks.length === 0 ||
      linkedTasks.some((task) => !isTerminalTaskStatus(task.status))
    ) {
      continue;
    }
    const event: SlackReactionEvent = linkedTasks.every((task) => task.status === "completed")
      ? "completed"
      : "failed";
    void finalizeSlackMessageReaction(
      app.client,
      channelId,
      timestamp,
      reactionName(event),
      event,
    ).catch((error) =>
      console.error(`[Slack] Failed to finalize reaction for ${channelId}/${timestamp}:`, error),
    );
  }

  for (const task of tasks) {
    const event: SlackReactionEvent = task.status === "completed" ? "completed" : "failed";
    for (const log of await getLogsByTaskIdChronological(task.id)) {
      if (log.eventType !== "task_steering" || log.newValue !== "slack_reaction") continue;
      const { slackChannelId: channelId, slackMessageTs: timestamp } = JSON.parse(log.metadata!);
      void finalizeSlackMessageReaction(
        app.client,
        channelId,
        timestamp,
        reactionName(event),
        event,
      ).catch((error) =>
        console.error(
          `[Slack] Failed to finalize steer reaction for ${channelId}/${timestamp}:`,
          error,
        ),
      );
    }
  }
}
