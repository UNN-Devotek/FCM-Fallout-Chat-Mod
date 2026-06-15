-- Add the "Gearing Up" Fallout 76 event announcement command, matching the
-- existing event-command pattern (shorthand trigger, announce action, Events
-- channel target). Idempotent: ON CONFLICT (trigger) DO NOTHING.
INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/gu', 'Announce Gearing Up', 'Gearing Up event on this server, player count [Server Count]/24.', 'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;
