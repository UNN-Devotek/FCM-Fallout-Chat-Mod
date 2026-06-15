-- Allow 'hud' as a message source (in-game two-way chat).
-- Previously the check constraint only permitted 'game' and 'discord', so every
-- HUD-sourced message broadcast live but failed to persist (messages_source_check
-- violation), never reaching history/backfill.
--
-- Idempotent: drop-if-exists then re-add (DO $$ guard so re-runs after db push
-- are safe — see docs/database/migrations.md).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_source_check'
  ) THEN
    ALTER TABLE messages DROP CONSTRAINT messages_source_check;
  END IF;

  ALTER TABLE messages
    ADD CONSTRAINT messages_source_check
    CHECK (source = ANY (ARRAY['game'::text, 'discord'::text, 'hud'::text]));
END $$;
