import type { WebClient } from "@slack/web-api";

// @slack/web-api platform errors set message to "An API error occurred: <code>"
// and store the raw Slack API code at error.data.error.
function slackCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const d = (error as { data?: { error?: unknown } }).data;
  return typeof d?.error === "string" ? d.error : undefined;
}

/**
 * Returns true only when conversations.info positively reports external members.
 * Returns false (allow join) on any lookup failure — we only block on a confirmed signal.
 */
async function isExternalChannel(client: WebClient, channelId: string): Promise<boolean> {
  try {
    const resp = await client.conversations.info({ channel: channelId });
    const ch = (resp.channel ?? {}) as {
      is_ext_shared?: boolean;
      is_pending_ext_shared?: boolean;
    };
    return ch.is_ext_shared === true || ch.is_pending_ext_shared === true;
  } catch (infoError) {
    // Lookup failed (channel_not_found, missing_scope, transient error, etc.).
    // Fall back to allowing the join — only block on a positive external signal.
    console.warn(
      `[withAutoJoin] conversations.info failed for ${channelId}; falling back to join attempt.`,
      infoError,
    );
    return false;
  }
}

/**
 * Wraps a Slack API call with automatic channel join for public channels.
 *
 * On not_in_channel: checks conversations.info first — if is_ext_shared or
 * is_pending_ext_shared is true the channel has external members; throws a
 * human-invite error instead of self-joining. Internal channels (including
 * Enterprise Grid org-shared channels) proceed normally.
 * On private channel (method_not_supported_for_channel_type): throws a
 * descriptive error telling the caller to /invite the bot.
 */
export async function withAutoJoin<T>(
  client: WebClient,
  channelId: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (slackCode(error) !== "not_in_channel") throw error;

    // Fail closed: never auto-join a channel that has external members.
    if (await isExternalChannel(client, channelId)) {
      throw new Error(
        `Cannot auto-join external channel ${channelId} — invite the bot with /invite @<bot-name> first.`,
      );
    }

    try {
      await client.conversations.join({ channel: channelId });
    } catch (joinError) {
      if (slackCode(joinError) === "method_not_supported_for_channel_type") {
        throw new Error(
          `Cannot access private channel ${channelId} — invite the bot with /invite @<bot-name> first.`,
        );
      }
      throw joinError;
    }

    return await fn();
  }
}
