-- Keep the message source contract aligned with the producers in the app.
-- The original constraint admitted only game/discord/hud, while MCP, WS and
-- relay ingestion also persist their source for auditability.
--
-- This migration is idempotent because hosted startup runs `prisma db push`
-- before migration bookkeeping. The same SQL is also applied by the explicit
-- post-push compatibility patch used by that bootstrap path.

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

  IF definition IS NULL OR position('game' IN definition) = 0
                         OR position('discord' IN definition) = 0
                         OR position('hud' IN definition) = 0
                         OR position('relay' IN definition) = 0
                         OR position('mcp' IN definition) = 0
                         OR position('ws' IN definition) = 0 THEN
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
        'ws'::text
      ]));
  END IF;
END $$;

-- Repair only the untouched stock rule. Admin-customized metadata is left
-- alone. The desired default is targeted slur protection; ordinary profanity
-- remains available in chat.
UPDATE "automod_rules"
   SET "trigger_metadata" = '{"presets":["SLURS"],"require_target":true}'::jsonb
 WHERE "id" = 'a0000000-0000-0000-0000-000000000002'
   AND "trigger_type" = 'KEYWORD_PRESET'
   AND COALESCE("trigger_metadata", '{}'::jsonb) IN (
         '{"presets":["PROFANITY","SEXUAL_CONTENT","SLURS"],"allow_list":["ass","damn","fuck","hell","shit"]}'::jsonb,
         '{"presets":["SEXUAL_CONTENT","SLURS"]}'::jsonb
       );
