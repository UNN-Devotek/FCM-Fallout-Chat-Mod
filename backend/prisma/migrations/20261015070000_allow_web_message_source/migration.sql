-- Admin WebSocket acceptance persists source web; preserve every existing source.
DO $$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_constraintdef(c.oid)
    INTO definition
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.oid = 'messages'::regclass
     AND c.conname = 'messages_source_check';

  IF definition IS NULL OR position('game' IN definition) = 0
                         OR position('discord' IN definition) = 0
                         OR position('hud' IN definition) = 0
                         OR position('relay' IN definition) = 0
                         OR position('mcp' IN definition) = 0
                         OR position('ws' IN definition) = 0
                         OR position('''web''::text' IN definition) = 0
                         OR position('bot' IN definition) = 0 THEN
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
        'web'::text,
        'bot'::text
      ]));
  END IF;
END $$;
