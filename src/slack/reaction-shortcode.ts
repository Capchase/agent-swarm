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

/**
 * A shortcode, optionally colon-wrapped, plus at most one `::skin-tone-[2-6]`
 * suffix — `reactions.add` accepts names like `thumbsup::skin-tone-6`
 * (https://api.slack.com/methods/reactions.add).
 */
export const SLACK_REACTION_SHORTCODE_PATTERN = /^[a-z0-9_+'-]+(::skin-tone-[2-6])?$/;

export function normalizeSlackReactionShortcode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().replace(/^:/, "").replace(/:$/, "").toLowerCase();
  if (!normalized || !SLACK_REACTION_SHORTCODE_PATTERN.test(normalized)) return null;
  return normalized;
}

const ACCEPTANCE_EVENTS = ["accepted", "buffered", "now", "steered"] as const;

export function reactionName(event: SlackReactionEvent): string {
  const raw = process.env[SLACK_REACTION_CONFIG_KEYS[event]];
  const normalized = normalizeSlackReactionShortcode(raw);
  return normalized ?? SLACK_REACTION_DEFAULTS[event];
}

/**
 * Best-effort fallback candidates for `finalizeSlackMessageReaction`: every
 * code default plus whatever each acceptance event's config key currently
 * names. This alone would miss a name that was applied under a config value
 * since changed or reloaded away — the primary mechanism cleanup relies on
 * is discovering the bot's own reaction straight from Slack (`reactions.get`
 * on the message), which reads live state instead of process memory and so
 * is correct across restarts and any number of config reloads.
 */
export function acceptanceReactionNames(): string[] {
  const names = new Set<string>(ACCEPTANCE_EVENTS.map((event) => SLACK_REACTION_DEFAULTS[event]));
  for (const event of ACCEPTANCE_EVENTS) names.add(reactionName(event));
  return [...names];
}
