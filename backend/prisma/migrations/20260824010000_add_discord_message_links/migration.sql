-- Retain the Discord snowflake for every bridged message so edits can travel
-- in both directions without parsing formatted bot text.
CREATE TABLE IF NOT EXISTS discord_message_links (
  id SERIAL PRIMARY KEY,
  message_id UUID NOT NULL,
  discord_message_id TEXT NOT NULL,
  discord_channel_id TEXT NOT NULL,
  discord_prefix TEXT NOT NULL,
  is_bot_message BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT discord_message_links_message_id_key UNIQUE (message_id),
  CONSTRAINT discord_message_links_discord_message_key UNIQUE (discord_message_id, discord_channel_id)
);

CREATE INDEX IF NOT EXISTS idx_discord_message_links_discord_message_id
  ON discord_message_links (discord_message_id);
