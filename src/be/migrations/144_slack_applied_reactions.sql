-- Durable provenance for which reaction shortcodes this feature applied to a
-- Slack message. Finalization intersects this with the bot's live reaction
-- list so cleanup only ever removes a reaction this feature is known to have
-- added -- never an unrelated reaction the same bot happens to own.
CREATE TABLE slack_applied_reactions (
  channel_id    TEXT NOT NULL,
  message_ts    TEXT NOT NULL,
  reaction_name TEXT NOT NULL,
  applied_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by    TEXT,
  updated_by    TEXT,
  PRIMARY KEY (channel_id, message_ts, reaction_name)
);
