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
 * Acceptance-stage provenance: which reaction names THIS process applied to a
 * message, keyed first by `${channel}:${timestamp}` and then by the bot user
 * id (`auth.test`) that applied them. Only acceptance-stage writes
 * (`ackSlackMessage`) are recorded; the terminal write in
 * `finalizeSlackMessageReaction` is not, so a finalized message never
 * re-enters the store and a terminal reaction is never a removal candidate.
 *
 * Binding a record to the applying bot identity matters because
 * `reactions.remove` only ever removes the CALLING user's own reaction: a
 * record made by bot A is useless to a client that now authenticates as bot
 * B, and treating it as B's own would delete a same-named reaction B applied
 * for some unrelated reason.
 *
 * ACCEPTED LIMITATION (maintainer decision, Daniel Munoz, 2026-09-08: "No db
 * migration"): this store is process memory only and is deliberately not
 * persisted. An API restart between acknowledge and finalize loses the
 * record, so finalize removes nothing for that message and both the
 * acceptance and the terminal reaction stay on it. Leaving a stale reaction
 * behind is the accepted trade against deleting a reaction this feature never
 * applied. Entries are released at finalize (see
 * `finalizeSlackMessageReaction`) so the store cannot grow without bound.
 */
const acceptanceProvenance = new Map<string, Map<string, Set<string>>>();

function messageKey(channel: string, timestamp: string): string {
  return `${channel}:${timestamp}`;
}

/** Test-only: drop every acceptance-stage provenance record, modelling the
 * memory loss of an API restart between acknowledge and finalize. */
export function _resetReactionProvenanceForTests(): void {
  acceptanceProvenance.clear();
}

/** Test-only: number of messages that currently hold an acceptance-stage
 * provenance record, so a test can pin that finalize releases them. */
export function _reactionProvenanceSizeForTests(): number {
  return acceptanceProvenance.size;
}

/**
 * Record that THIS bot identity applied `name` to `channel`/`timestamp` at
 * the acceptance stage, so finalize's cleanup knows this exact name is a
 * removal candidate for this message (see `discoverAppliedReactionNames`).
 *
 * When the bot's own user id cannot be resolved, nothing is recorded: the
 * reaction stays as best-effort feedback but is never cleaned up, because a
 * record with no owner cannot be matched safely at finalize.
 */
async function recordAcceptanceReaction(
  client: SlackReactionClient,
  channel: string,
  timestamp: string,
  name: string,
): Promise<void> {
  const botUserId = await getBotUserId(client);
  if (!botUserId) {
    console.log(
      scrubSecrets(
        `[Slack] could not resolve bot user id via auth.test; ${name} on ${channel}/${timestamp} is not recorded and will not be cleaned up at finalization`,
      ),
    );
    return;
  }
  const key = messageKey(channel, timestamp);
  let byBot = acceptanceProvenance.get(key);
  if (!byBot) {
    byBot = new Map();
    acceptanceProvenance.set(key, byBot);
  }
  let names = byBot.get(botUserId);
  if (!names) {
    names = new Set();
    byBot.set(botUserId, names);
  }
  names.add(name);
}

/**
 * Ask Slack which reaction names this bot currently has on the message, then
 * narrow that list to only the names THIS bot identity recorded (in
 * `acceptanceProvenance`) as ones this feature actually applied.
 *
 * `full: true` is required for Slack to return the complete reaction list,
 * and each candidate is checked against the bot's own user id (from
 * `auth.test`) so a human's reaction never triggers a needless
 * `reactions.remove` call. The bot-owned check alone is not a sufficient
 * discriminator: the same bot user may own a reaction this feature never
 * applied (added by unrelated automation), and that reaction must never be
 * swept up. Intersecting live bot-owned names with this identity's own
 * provenance record is what makes cleanup precise across any number of
 * config reloads between acceptance and finalization -- the record tracks
 * exactly what THIS feature applied, independent of the live config.
 *
 * With no record for this bot on this message (nothing applied, provenance
 * lost to a restart, or applied under a different bot identity) Slack is not
 * consulted at all and nothing is removed.
 */
async function discoverAppliedReactionNames(
  client: SlackReactionClient,
  botUserId: string,
  channel: string,
  timestamp: string,
): Promise<string[]> {
  const appliedByThisFeature = acceptanceProvenance
    .get(messageKey(channel, timestamp))
    ?.get(botUserId);
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

/**
 * Add one reaction, with the shared `invalid_name` fallback and error
 * handling. `stage` decides whether a successful write is recorded as
 * acceptance-stage provenance: only `"acceptance"` writes are removal
 * candidates at finalize; a `"terminal"` write is never recorded, so it is
 * never removed and never re-populates the store after finalize released it.
 *
 * `already_reacted` is NOT proof of ownership: the same bot user may already
 * own that name through unrelated automation. It establishes no new record.
 * A record that already exists for this name (a duplicate acknowledgement of
 * a reaction this feature did apply) is left untouched, so provenance is kept.
 */
async function addReaction(
  client: SlackReactionClient,
  channel: string,
  timestamp: string,
  name: string,
  event: SlackReactionEvent | undefined,
  stage: "acceptance" | "terminal",
): Promise<void> {
  try {
    await client.reactions.add({ channel, name, timestamp });
    if (stage === "acceptance") await recordAcceptanceReaction(client, channel, timestamp, name);
  } catch (error) {
    if (slackErrorCode(error) === "already_reacted") return;
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
        if (stage === "acceptance")
          await recordAcceptanceReaction(client, channel, timestamp, fallback);
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
 * Acknowledge that the swarm accepted a Slack message (acceptance stage).
 *
 * Reactions are best-effort feedback only: Slack API failures must never block
 * message ingestion or task creation. Slack reports repeated acknowledgements
 * as `already_reacted`, which is an expected no-op. A reaction this call
 * applies is recorded as acceptance-stage provenance so
 * `finalizeSlackMessageReaction` can remove exactly it later.
 */
export async function ackSlackMessage(
  client: SlackReactionClient,
  channel: string,
  timestamp: string,
  name: string,
  event?: SlackReactionEvent,
): Promise<void> {
  await addReaction(client, channel, timestamp, name, event, "acceptance");
}

/**
 * Replace this bot's acceptance reaction with the terminal task outcome.
 *
 * The removal candidate set is exactly this bot identity's recorded
 * acceptance-stage names intersected with the bot's live reactions on the
 * message (`discoverAppliedReactionNames`) -- never the currently configured
 * acceptance names on their own. A configured name is not, by itself, proof
 * this feature ever applied it: `SLACK_REACTION_ACCEPTED` could change
 * between acceptance and finalization to a name some unrelated automation
 * already owns on this bot, and that reaction must never be swept up.
 *
 * The terminal write itself is never recorded, so a repeated finalize (the
 * watcher and the renderer can both reach a terminal message) finds no
 * record, consults nothing and removes nothing: a terminal reaction is never
 * removed once added.
 */
export async function finalizeSlackMessageReaction(
  client: SlackReactionClient,
  channel: string,
  timestamp: string,
  outcome: string,
  event?: SlackReactionEvent,
): Promise<void> {
  const botUserId = await getBotUserId(client);
  if (!botUserId) {
    console.log(
      scrubSecrets(
        "[Slack] could not resolve bot user id via auth.test; skipping live reaction discovery and reaction cleanup for this message",
      ),
    );
  }
  const candidateNames = botUserId
    ? await discoverAppliedReactionNames(client, botUserId, channel, timestamp)
    : [];

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

  // This message's provenance is only needed for one finalize pass. Release
  // the whole message entry (every bot identity): a record left by a bot
  // this client no longer authenticates as could never be acted on anyway,
  // because `reactions.remove` only removes the caller's own reaction.
  acceptanceProvenance.delete(messageKey(channel, timestamp));

  await addReaction(client, channel, timestamp, outcome, event, "terminal");
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
