-- Add parent_channel_id to messages so sub-channel messages carry their main channel reference.
-- Used for channel tag attribution when displaying or querying messages by main channel context.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS parent_channel_id UUID REFERENCES channels(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_parent_channel_id ON messages (parent_channel_id, created_at DESC);
