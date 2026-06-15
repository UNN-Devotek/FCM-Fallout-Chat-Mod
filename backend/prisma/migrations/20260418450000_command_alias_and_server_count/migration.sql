-- Add alias column
ALTER TABLE chat_commands ADD COLUMN IF NOT EXISTS alias TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS chat_commands_alias_key ON chat_commands(alias);

-- Seed /server-count with /sc alias
INSERT INTO chat_commands (trigger, alias, description, response, action_type, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES (
  '/server-count',
  '/sc',
  'Shows server population and ChatMod user count',
  '◈ SERVER: [Server Count]/24 players on this server · [Mod Users] with ChatMod installed',
  'server-broadcast',
  30,
  true,
  false,
  NOW(),
  NOW()
) ON CONFLICT (trigger) DO NOTHING;
