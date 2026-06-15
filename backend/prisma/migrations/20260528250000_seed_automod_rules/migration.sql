-- Seed the three Discord-equivalent automod rules (disabled by default).
-- The original seed in 20260528230000_add_automod_engine used INVALID UUIDs
-- ('10000000-automod-...' — 'automod' is not hex), so its INSERT errored and
-- no rules landed. This migration re-seeds with valid UUIDs. Idempotent.
INSERT INTO "automod_rules"
  ("id", "name", "enabled", "trigger_type", "trigger_metadata", "actions", "exempt_channel_ids", "exempt_roles")
VALUES
  (
    'a0000000-0000-0000-0000-000000000001',
    'Block spam content',
    false,
    'SPAM',
    '{"dupe_limit": 5, "dupe_window_ms": 10000, "rate_limit": 10, "rate_window_ms": 30000}',
    '[{"type":"BLOCK"},{"type":"ALERT"}]',
    '{}',
    '{}'
  ),
  (
    'a0000000-0000-0000-0000-000000000002',
    'Block flagged words',
    false,
    'KEYWORD_PRESET',
    '{"presets": ["PROFANITY", "SEXUAL_CONTENT", "SLURS"], "allow_list": ["ass", "damn", "fuck", "hell", "shit"]}',
    '[{"type":"BLOCK"},{"type":"ALERT"}]',
    '{}',
    '{}'
  ),
  (
    'a0000000-0000-0000-0000-000000000003',
    'Block mention spam',
    false,
    'MENTION_SPAM',
    '{"mention_total_limit": 20}',
    '[{"type":"BLOCK"},{"type":"ALERT"}]',
    '{}',
    '{}'
  )
ON CONFLICT ("id") DO NOTHING;

-- Seed mod_log_channel_id in moderation_settings (default: #vault-security).
-- The original migration's seed of this key may also have been skipped if the
-- failing rule INSERT aborted that migration's transaction.
INSERT INTO "moderation_settings" ("key", "value", "updated_at")
VALUES ('mod_log_channel_id', '1509345764654977035', NOW())
ON CONFLICT ("key") DO NOTHING;
