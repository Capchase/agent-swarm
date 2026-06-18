import type { WebClient } from "@slack/web-api";

// Capchase's Slack workspace team ID. Used to detect external (Slack Connect) channels.
// Override via SLACK_HOST_TEAM_ID env var if the workspace changes.
const CAPCHASE_HOST_TEAM_ID = process.env.SLACK_HOST_TEAM_ID ?? "T016H7SJJP4";

// @slack/web-api platform errors set message to "An API error occurred: <code>"
// and store the raw Slack API code at error.data.error.
function slackCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const d = (error as { data?: { error?: unknown } }).data;
  return typeof d?.error === "string" ? d.error : undefined;
}

/**
 * Returns true if the channel has any external (non-host-org) members based on
 * conversations.info fields. Fails closed: unknown/missing fields → not external.
 */
async function isExternalChannel(client: WebClient, channelId: string): Promise<boolean> {
  const resp = await client.conversations.info({ channel: channelId });
  const ch = (resp.channel ?? {}) as {
    is_ext_shared?: boolean;
    is_pending_ext_shared?: boolean;
    shared_team_ids?: string[];
    internal_team_ids?: string[];
  };

  if (ch.is_ext_shared === true || ch.is_pending_ext_shared === true) return true;

  const allSharedIds = [...(ch.shared_team_ids ?? []), ...(ch.internal_team_ids ?? [])];
  return allSharedIds.some((id) => id !== "" && id !== CAPCHASE_HOST_TEAM_ID);
}

/**
 * Wraps a Slack API call with automatic channel join for public channels.
 *
 * On not_in_channel: checks conversations.info first — if the channel is external
 * (Slack Connect / shared with another org), throws a human-invite error rather than
 * self-joining, to prevent the bot from silently entering channels with external members.
 * For normal internal public channels, calls conversations.join and retries once.
 * On private channel (method_not_supported_for_channel_type): throws a descriptive
 * error telling the caller the bot must be /invite-d — it cannot self-join private channels.
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
