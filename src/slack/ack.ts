import type { WebClient } from "@slack/web-api";
import {
  deleteAppliedSlackReaction,
  getAppliedSlackReactionNames,
  getLogsByTaskIdChronological,
  getSlackTasksInThread,
  recordAppliedSlackReaction,
} from "../be/db";
import { recordSlackReactionInvalidName } from "../otel";
import { type AgentTask, isTerminalTaskStatus } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { getSlackApp } from "./app";
import {
  acceptanceReactionNames,
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
 * Ask Slack which reaction names this bot currently has on the message, then
 * narrow that list to only the names durably recorded (in
 * `slack_applied_reactions`) as ones this feature actually applied.
 *
 * `full: true` is required for Slack to return the complete reaction list,
 * and each candidate is checked against the bot's own user id (from
 * `auth.test`) so a human's reaction never triggers a needless
 * `reactions.remove` call. The bot-owned check alone is not a sufficient
 * discriminator: the same bot user may own a reaction this feature never
 * applied (added by unrelated automation), and that reaction must never be
 * swept up. Intersecting live bot-owned names with the durable provenance
 * table is what makes cleanup precise across a process restart or any
 * number of config reloads between acceptance and finalization -- the
 * provenance table records exactly what THIS feature applied, independent
 * of process memory or the live config.
 *
 * If the bot's own user id can't be resolved, live discovery is skipped
 * entirely (rather than falling back to trial-removing every returned name)
 * and cleanup relies only on the configured acceptance names.
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
  let appliedByThisFeature: Set<string>;
  try {
    appliedByThisFeature = new Set(await getAppliedSlackReactionNames(channel, timestamp));
  } catch {
    appliedByThisFeature = new Set();
  }
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

/** Best-effort: record that this feature applied `name`, swallowing DB errors
 * so a provenance-write failure never blocks the Slack acknowledgement it
 * describes (reactions remain best-effort feedback, per `ackSlackMessage`). */
async function trackAppliedReaction(
  channel: string,
  timestamp: string,
  name: string,
): Promise<void> {
  try {
    await recordAppliedSlackReaction(channel, timestamp, name);
  } catch (error) {
    console.log(
      scrubSecrets(
        `[Slack] failed to record applied-reaction provenance for ${name}: ${error instanceof Error ? error.message : error}`,
      ),
    );
  }
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
    await trackAppliedReaction(channel, timestamp, name);
  } catch (error) {
    if (slackErrorCode(error) === "already_reacted") {
      await trackAppliedReaction(channel, timestamp, name);
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
        await trackAppliedReaction(channel, timestamp, fallback);
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

/** Replace this bot's acceptance reaction with the terminal task outcome. */
export async function finalizeSlackMessageReaction(
  client: SlackReactionClient,
  channel: string,
  timestamp: string,
  outcome: string,
  event?: SlackReactionEvent,
): Promise<void> {
  const candidateNames = new Set(acceptanceReactionNames());
  for (const name of await discoverAppliedReactionNames(client, channel, timestamp)) {
    candidateNames.add(name);
  }

  for (const name of candidateNames) {
    try {
      await client.reactions.remove({ channel, name, timestamp });
      // Bound the provenance table's growth: a name recorded as applied and
      // now confirmed removed no longer needs to be tracked for this message.
      await deleteAppliedSlackReaction(channel, timestamp, name).catch(() => {});
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
