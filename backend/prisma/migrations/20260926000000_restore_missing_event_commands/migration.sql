-- Restore three original event shortcuts that are absent on hosted Dev.
-- Keep existing administrator edits intact, including disabled commands.
INSERT INTO chat_commands (
  trigger, description, response, action_type, target_channel_id,
  allowed_channel_id, cooldown_sec, enabled, requires_args, relay_to_discord,
  created_at, updated_at
)
VALUES
  ('/acp', 'Announce A Colossal Problem (Earle)', 'A Colossal Problem event on this server.', 'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, true, NOW(), NOW()),
  ('/bob', 'Announce Beasts of Burden', 'Beasts of Burden event on this server.', 'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, true, NOW(), NOW()),
  ('/ct', 'Announce Campfire Tales', 'Campfire Tales event on this server.', 'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, true, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;
