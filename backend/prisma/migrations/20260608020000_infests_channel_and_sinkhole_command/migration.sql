-- Wire the Infests channel to its Discord channel and enable relay
UPDATE channels
SET discord_relay      = true,
    discord_channel_id = '1513363450888454184',
    updated_at         = NOW()
WHERE id = '983995c1-f9ab-44c0-9b78-8b4cbf497273';

-- Add Sinkhole Solutions event announcement command
INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, relay_to_discord, created_at, updated_at)
VALUES (
  '/ss',
  'Announce Sinkhole Solutions',
  'Sinkhole Solutions event on this server.',
  'announce',
  '00000000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000001',
  30,
  true,
  false,
  true,
  NOW(),
  NOW()
) ON CONFLICT (trigger) DO NOTHING;
