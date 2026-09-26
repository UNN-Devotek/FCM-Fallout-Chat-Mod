-- Giveaway announcements and results use source='bot'. Keep the database
-- constraint aligned with all persisted message producers. Hosted startup may
-- have already applied the matching post-push patch, so this must be idempotent.

DO $$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_constraintdef(c.oid)
    INTO definition
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'messages'
     AND c.conname = 'messages_source_check';

  IF definition IS NULL OR position('bot' IN definition) = 0 THEN
    IF definition IS NOT NULL THEN
      ALTER TABLE messages DROP CONSTRAINT messages_source_check;
    END IF;

    ALTER TABLE messages
      ADD CONSTRAINT messages_source_check
      CHECK (source = ANY (ARRAY[
        'game'::text,
        'discord'::text,
        'hud'::text,
        'relay'::text,
        'mcp'::text,
        'ws'::text,
        'bot'::text
      ]));
  END IF;
END $$;
