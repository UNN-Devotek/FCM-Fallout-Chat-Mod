-- Persist the timestamp so edited messages retain their marker after reloads.
ALTER TABLE IF EXISTS messages
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ(6);

ALTER TABLE IF EXISTS party_messages
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ(6);

ALTER TABLE IF EXISTS private_messages
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ(6);
