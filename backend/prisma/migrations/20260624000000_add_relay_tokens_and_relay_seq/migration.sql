-- Migration: add_relay_tokens_and_relay_seq
-- Adds the relay_seq cursor column to messages and the hud_pairing_tokens table.
-- All DDL is idempotent (IF NOT EXISTS / DO $$ guards) per project migration policy.
--
-- Identity model note:
--   user_id is TEXT (relay-owned identity, e.g. "user_" + hex).
--   It is NOT a FK to users — a fresh register is anonymous until the link flow
--   completes. linked_user_id (UUID FK → users.id) is the authoritative "linked" flag.

-- Add relay_seq column to messages (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'messages' AND column_name = 'relay_seq'
  ) THEN
    ALTER TABLE messages ADD COLUMN relay_seq BIGINT;
  END IF;
END $$;

-- Index for relay_seq cursor queries (partial — only rows that have a relay_seq)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'messages' AND indexname = 'messages_relay_seq_idx'
  ) THEN
    CREATE INDEX messages_relay_seq_idx ON messages (relay_seq) WHERE relay_seq IS NOT NULL;
  END IF;
END $$;

-- hud_pairing_tokens table (idempotent)
-- user_id is TEXT (relay identity namespace) — NOT a UUID FK to users.
-- linked_user_id is the FK to users.id, set by markRelayTokenLinked() after link redemption.
CREATE TABLE IF NOT EXISTS hud_pairing_tokens (
  id             UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  token_hash     TEXT        NOT NULL,
  token_prefix   TEXT        NOT NULL,
  fo76_name      TEXT        NOT NULL,
  revoked_at     TIMESTAMPTZ,
  last_used_at   TIMESTAMPTZ,
  user_id        TEXT        NOT NULL,
  role           TEXT        NOT NULL DEFAULT 'user',
  -- linked_user_id: NULL = limited (receive-only); SET by /api/link/redeem via markRelayTokenLinked()
  linked_user_id UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add linked_user_id to existing tables (idempotent — safe to run on a table created above too)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'hud_pairing_tokens' AND column_name = 'linked_user_id'
  ) THEN
    ALTER TABLE hud_pairing_tokens
      ADD COLUMN linked_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Indexes on hud_pairing_tokens (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'hud_pairing_tokens' AND indexname = 'hud_pairing_tokens_token_prefix_idx'
  ) THEN
    CREATE INDEX hud_pairing_tokens_token_prefix_idx ON hud_pairing_tokens (token_prefix);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'hud_pairing_tokens' AND indexname = 'hud_pairing_tokens_user_id_idx'
  ) THEN
    CREATE INDEX hud_pairing_tokens_user_id_idx ON hud_pairing_tokens (user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'hud_pairing_tokens' AND indexname = 'hud_pairing_tokens_linked_user_id_idx'
  ) THEN
    CREATE INDEX hud_pairing_tokens_linked_user_id_idx ON hud_pairing_tokens (linked_user_id)
      WHERE linked_user_id IS NOT NULL;
  END IF;
END $$;
