export type SlackReactionEvent =
  | "accepted"
  | "buffered"
  | "now"
  | "steered"
  | "completed"
  | "failed";

export const SLACK_REACTION_DEFAULTS: Record<SlackReactionEvent, string> = {
  accepted: "eyes",
  buffered: "heavy_plus_sign",
  now: "zap",
  steered: "speech_balloon",
  completed: "white_check_mark",
  failed: "x",
};

export const SLACK_REACTION_CONFIG_KEYS: Record<SlackReactionEvent, string> = {
  accepted: "SLACK_REACTION_ACCEPTED",
  buffered: "SLACK_REACTION_BUFFERED",
  now: "SLACK_REACTION_NOW",
  steered: "SLACK_REACTION_STEERED",
  completed: "SLACK_REACTION_COMPLETED",
  failed: "SLACK_REACTION_FAILED",
};

export const SLACK_REACTION_SHORTCODE_PATTERN = /^[a-z0-9_+'-]+$/;

export function normalizeSlackReactionShortcode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().replace(/^:/, "").replace(/:$/, "").toLowerCase();
  if (!normalized || !SLACK_REACTION_SHORTCODE_PATTERN.test(normalized)) return null;
  return normalized;
}

const ACCEPTANCE_EVENTS = ["accepted", "buffered", "now", "steered"] as const;
type AcceptanceEvent = (typeof ACCEPTANCE_EVENTS)[number];

function isAcceptanceEvent(event: SlackReactionEvent): event is AcceptanceEvent {
  return (ACCEPTANCE_EVENTS as readonly string[]).includes(event);
}

/**
 * Every name `reactionName()` has recently resolved for an acceptance event
 * during this process's lifetime. Config can reload live (a swarm_config
 * upsert rewrites process.env), so the value a message was actually
 * acknowledged with can differ from what the key names by the time
 * cleanup runs. Cleanup unions this history with the current live config
 * and the code defaults so it usually finds the reaction it needs to remove.
 *
 * Bounded to MAX_SEEN_NAMES_PER_EVENT per event (FIFO eviction: `Set`
 * preserves insertion order) so a long-lived process cannot leak memory if a
 * key is reconfigured many times. A name applied further back than the
 * eviction bound falls out of `acceptanceReactionNames()`'s union and is left
 * un-removed on cleanup — a bounded staleness window, not full correctness.
 */
const MAX_SEEN_NAMES_PER_EVENT = 8;
const seenAcceptanceReactionNames = new Map<AcceptanceEvent, Set<string>>();

export function reactionName(event: SlackReactionEvent): string {
  const raw = process.env[SLACK_REACTION_CONFIG_KEYS[event]];
  const normalized = normalizeSlackReactionShortcode(raw);
  const name = normalized ?? SLACK_REACTION_DEFAULTS[event];
  if (isAcceptanceEvent(event)) {
    let seen = seenAcceptanceReactionNames.get(event);
    if (!seen) {
      seen = new Set();
      seenAcceptanceReactionNames.set(event, seen);
    }
    // Re-inserting moves `name` to the most-recently-used end so an eviction
    // never drops a name that is still in active use.
    seen.delete(name);
    seen.add(name);
    while (seen.size > MAX_SEEN_NAMES_PER_EVENT) {
      const oldest = seen.values().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
  }
  return name;
}

export function acceptanceReactionNames(): string[] {
  const names = new Set<string>(ACCEPTANCE_EVENTS.map((event) => SLACK_REACTION_DEFAULTS[event]));
  for (const event of ACCEPTANCE_EVENTS) names.add(reactionName(event));
  for (const event of ACCEPTANCE_EVENTS) {
    for (const name of seenAcceptanceReactionNames.get(event) ?? []) names.add(name);
  }
  return [...names];
}

/** Test-only: clear the cross-call history `acceptanceReactionNames()` unions in. */
export function _resetAcceptanceReactionHistoryForTests(): void {
  seenAcceptanceReactionNames.clear();
}
