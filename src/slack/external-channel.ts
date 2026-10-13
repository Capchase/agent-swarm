import type { WebClient } from "@slack/web-api";
import { isEnvFlagEnabled } from "../utils/env-flag";
import { scrubSecrets } from "../utils/secret-scrubber";
import { slackCode, slackMissingScopeMessage } from "./channel-join";

/**
 * External (Slack Connect) channel detection and enforcement.
 *
 * A channel is external when `conversations.info` returns `is_ext_shared` or
 * `is_pending_ext_shared`, or when the event envelope carries
 * `is_ext_shared_channel: true`. `is_shared` / `is_org_shared` alone are
 * internal (Enterprise Grid org-shared channels).
 *
 * `SLACK_BLOCK_EXTERNAL_CHANNELS` is read at call time so a dashboard change
 * applies without a restart.
 */

export type ChannelExternality = "external" | "internal" | "unknown";
export type ExternalChannelTrigger = "joined" | "shared" | "boot-scan";

const EXTERNALITY_TTL_MS = 10 * 60 * 1000;
const EXTERNALITY_CACHE_MAX = 500;
const ALERT_DEDUPE_MS = 60 * 60 * 1000;

const externalityCache = new Map<string, { value: "external" | "internal"; expiresAt: number }>();
const alertSentAt = new Map<string, number>();

export const EXTERNAL_CHANNEL_BLOCKED_REPLY =
  "This channel is shared with another organization. The swarm does not work here.";

export function externalChannelToolError(channelId: string): string {
  return `Channel ${channelId} is shared with another organization. SLACK_BLOCK_EXTERNAL_CHANNELS blocks swarm messages there.`;
}

export function isBlockExternalEnabled(): boolean {
  return isEnvFlagEnabled("SLACK_BLOCK_EXTERNAL_CHANNELS", false);
}

/** Reset caches between tests. */
export function resetExternalChannelStateForTesting(): void {
  externalityCache.clear();
  alertSentAt.clear();
}

export function invalidateChannelExternality(channelId: string): void {
  externalityCache.delete(channelId);
}

/**
 * Looks up whether a channel is external. Known results are cached for 10
 * minutes; an API error returns "unknown" and is not cached.
 */
export async function getChannelExternality(
  client: WebClient,
  channelId: string,
): Promise<ChannelExternality> {
  const cached = externalityCache.get(channelId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) externalityCache.delete(channelId);

  let value: "external" | "internal";
  try {
    const resp = await client.conversations.info({ channel: channelId });
    const ch = (resp.channel ?? {}) as {
      is_ext_shared?: boolean;
      is_pending_ext_shared?: boolean;
    };
    value =
      ch.is_ext_shared === true || ch.is_pending_ext_shared === true ? "external" : "internal";
  } catch (error) {
    console.warn(`[Slack] conversations.info failed for ${channelId}:`, error);
    return "unknown";
  }

  // Evict oldest entry (insertion-ordered Map) once the cap is reached.
  if (externalityCache.size >= EXTERNALITY_CACHE_MAX) {
    const oldest = externalityCache.keys().next().value;
    if (oldest !== undefined) externalityCache.delete(oldest);
  }
  externalityCache.set(channelId, { value, expiresAt: Date.now() + EXTERNALITY_TTL_MS });
  return value;
}

/**
 * True when the flag is on and the channel is external. "unknown" does not
 * block (fail open, as `withAutoJoin` does).
 */
export async function shouldBlockChannel(
  client: WebClient,
  channelId: string,
  envelopeFlag?: boolean,
): Promise<boolean> {
  if (!isBlockExternalEnabled()) return false;
  if (envelopeFlag === true) return true;
  const externality = await getChannelExternality(client, channelId);
  if (externality === "unknown") {
    console.warn(
      `[Slack] Could not tell if channel ${channelId} is external; not blocking (fail open)`,
    );
  }
  return externality === "external";
}

async function postExternalChannelAlert(
  client: WebClient,
  channelId: string,
  trigger: ExternalChannelTrigger,
  leave: string,
  scopeHint?: string,
): Promise<void> {
  const alertsChannel = process.env.SLACK_ALERTS_CHANNEL?.trim();
  if (!alertsChannel) {
    console.warn("[Slack] SLACK_ALERTS_CHANNEL not set; skipping external channel alert");
    return;
  }

  const key = `${channelId}:${trigger}`;
  const lastSent = alertSentAt.get(key);
  if (lastSent !== undefined && Date.now() - lastSent < ALERT_DEDUPE_MS) return;
  alertSentAt.set(key, Date.now());

  const lines = [
    `:no_entry: Swarm bot in external Slack channel <#${channelId}> (${channelId})`,
    `Trigger: ${trigger}`,
    `Leave: ${leave}`,
    ...(scopeHint ? [scopeHint] : []),
    "Inbound guard: active. The swarm creates no task from this channel.",
  ];

  try {
    await client.chat.postMessage({
      channel: alertsChannel,
      text: scrubSecrets(lines.join("\n")),
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (error) {
    console.error(
      "[Slack] Failed to send external channel alert:",
      scrubSecrets(error instanceof Error ? error.message : String(error)),
    );
  }
}

/** Leaves an external channel and posts one alert with the result. */
export async function leaveExternalChannel(
  client: WebClient,
  channelId: string,
  reason: "joined" | "shared",
): Promise<void> {
  let leave: string;
  let scopeHint: string | undefined;
  try {
    // A bot that is not a member gets {"ok":false,"not_in_channel":true}; treat it as left.
    await client.conversations.leave({ channel: channelId });
    leave = "left";
  } catch (error) {
    const code = slackCode(error);
    const notInChannel =
      code === "not_in_channel" ||
      (error as { data?: { not_in_channel?: boolean } })?.data?.not_in_channel === true;
    if (notInChannel) {
      leave = "left";
    } else {
      leave = `failed (${code ?? "unknown_error"})`;
      if (code === "missing_scope") scopeHint = slackMissingScopeMessage(error);
      console.error(`[Slack] Failed to leave external channel ${channelId}: ${leave}`);
    }
  }
  if (leave === "left") console.log(`[Slack] Left external channel ${channelId} (${reason})`);
  await postExternalChannelAlert(client, channelId, reason, leave, scopeHint);
}

/**
 * Boot scan, report only: posts one alert per external channel the bot is in.
 * It never leaves a channel; a human decides.
 */
export async function scanExternalChannelsOnBoot(client: WebClient): Promise<void> {
  if (!isBlockExternalEnabled()) return;

  let cursor: string | undefined;
  do {
    const resp = await client.users.conversations({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    for (const ch of (resp.channels ?? []) as Array<{
      id?: string;
      is_ext_shared?: boolean;
      is_pending_ext_shared?: boolean;
    }>) {
      if (!ch.id || !(ch.is_ext_shared === true || ch.is_pending_ext_shared === true)) continue;
      await postExternalChannelAlert(client, ch.id, "boot-scan", "not attempted (report only)");
    }
    cursor = resp.response_metadata?.next_cursor || undefined;
  } while (cursor);
}
