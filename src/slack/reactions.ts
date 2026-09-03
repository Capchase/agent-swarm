import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { getLatestTaskByContextKey, getTaskBySlackMessageTs } from "../be/db";
import { createEvent, getInvokedSkillNamesForTask } from "../be/events";
import { slackContextKey } from "../tasks/context-key";
import type { AgentTask } from "../types";

// The skills ledger's outcome half. Maps a human's emoji reaction on a task's
// Slack thread onto `skill.outcome` events for every skill the task invoked.
// See runbooks/ and the approved plan linked from the PR for the full design.

interface ReactionEvent {
  type: "reaction_added" | "reaction_removed";
  user?: string;
  reaction: string;
  item: {
    type: string;
    channel?: string;
    ts?: string;
  };
}

type ReactionFamily = "feedback" | "gate";
type ReactionOutcome = "pass" | "fail";

const REACTION_MAPPING: Record<string, { family: ReactionFamily; outcome: ReactionOutcome }> = {
  "+1": { family: "feedback", outcome: "pass" },
  "-1": { family: "feedback", outcome: "fail" },
  white_check_mark: { family: "gate", outcome: "pass" },
  x: { family: "gate", outcome: "fail" },
};

function stripSkinTone(reaction: string): string {
  return reaction.split("::")[0] ?? reaction;
}

/**
 * Resolve a reaction's (channel, message ts) to a task, in the order fixed by
 * the approved plan: contextKey on the thread root, then a tracked progress/tree
 * message ts, then one conversations.history call to find the thread root.
 */
async function resolveTaskForReaction(
  client: WebClient,
  channel: string,
  ts: string,
): Promise<AgentTask | null> {
  const byContextKey = await getLatestTaskByContextKey(
    slackContextKey({ channelId: channel, threadTs: ts }),
  );
  if (byContextKey) return byContextKey;

  const byMessageTs = await getTaskBySlackMessageTs(ts);
  if (byMessageTs) return byMessageTs;

  try {
    const history = await client.conversations.history({
      channel,
      latest: ts,
      inclusive: true,
      limit: 1,
    });
    const threadTs = history.messages?.[0]?.thread_ts;
    if (threadTs && threadTs !== ts) {
      return await getLatestTaskByContextKey(slackContextKey({ channelId: channel, threadTs }));
    }
  } catch (error) {
    console.error(`[Slack] reactions: conversations.history failed for ${channel}:${ts}:`, error);
  }

  return null;
}

async function handleReaction(
  client: WebClient,
  reactionEvent: ReactionEvent,
  removed: boolean,
): Promise<void> {
  const reaction = stripSkinTone(reactionEvent.reaction);
  const mapping = REACTION_MAPPING[reaction];
  if (!mapping) return;

  const { channel, ts, type } = reactionEvent.item;
  if (type !== "message" || !channel || !ts) return;

  const task = await resolveTaskForReaction(client, channel, ts);
  if (!task) {
    console.log(
      `[Slack] reactions: no task match for channel=${channel} ts=${ts} reaction=${reaction}`,
    );
    return;
  }

  const skillNames = await getInvokedSkillNamesForTask(task.id);
  if (skillNames.length === 0) return;

  for (const skillName of skillNames) {
    await createEvent({
      category: "skill",
      event: "skill.outcome",
      source: "slack",
      taskId: task.id,
      agentId: task.agentId ?? undefined,
      data: {
        skillName,
        outcome: mapping.outcome,
        family: mapping.family,
        reaction,
        removed,
        reactedBy: reactionEvent.user,
        channel,
        messageTs: ts,
        source: "reaction-event",
      },
    });
  }
}

export function registerReactionHandler(app: App): void {
  app.event("reaction_added", async ({ event, client }) => {
    try {
      await handleReaction(client, event as ReactionEvent, false);
    } catch (error) {
      console.error("[Slack] reactions: failed to process reaction_added:", error);
    }
  });

  app.event("reaction_removed", async ({ event, client }) => {
    try {
      await handleReaction(client, event as ReactionEvent, true);
    } catch (error) {
      console.error("[Slack] reactions: failed to process reaction_removed:", error);
    }
  });
}
