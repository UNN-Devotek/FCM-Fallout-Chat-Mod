-- AutoMod rule engine: automod_rules + automod_violations tables.
-- Idempotent (baseline-migrations.sh re-runs after db push).

CREATE TABLE IF NOT EXISTS "automod_rules" (
  "id"                UUID        NOT NULL DEFAULT gen_random_uuid(),
  "name"              TEXT        NOT NULL,
  "enabled"           BOOLEAN     NOT NULL DEFAULT true,
  "trigger_type"      TEXT        NOT NULL,
  "trigger_metadata"  JSONB       NOT NULL DEFAULT '{}',
  "actions"           JSONB       NOT NULL DEFAULT '[]',
  "exempt_channel_ids" TEXT[]     NOT NULL DEFAULT '{}',
  "exempt_roles"      TEXT[]      NOT NULL DEFAULT '{}',
  "created_by_id"     UUID,
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "automod_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "automod_rules_enabled_idx" ON "automod_rules" ("enabled");

CREATE TABLE IF NOT EXISTS "automod_violations" (
  "id"              UUID        NOT NULL DEFAULT gen_random_uuid(),
  "rule_id"         UUID        NOT NULL,
  "user_id"         UUID        NOT NULL,
  "channel_id"      UUID,
  "message_content" TEXT        NOT NULL,
  "matched_keyword" TEXT,
  "matched_substr"  TEXT,
  "actions_taken"   JSONB       NOT NULL DEFAULT '[]',
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "automod_violations_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'automod_violations_rule_id_fkey'
  ) THEN
    ALTER TABLE "automod_violations"
      ADD CONSTRAINT "automod_violations_rule_id_fkey"
      FOREIGN KEY ("rule_id") REFERENCES "automod_rules"("id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "automod_violations_user_id_created_at_idx"
  ON "automod_violations" ("user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "automod_violations_rule_id_created_at_idx"
  ON "automod_violations" ("rule_id", "created_at" DESC);

-- Seed the three Discord-equivalent rules (disabled by default).
-- All use BLOCK + ALERT actions pointing at #vault-security.
INSERT INTO "automod_rules"
  ("id", "name", "enabled", "trigger_type", "trigger_metadata", "actions", "exempt_channel_ids", "exempt_roles")
VALUES
  (
    '10000000-automod-0000-0000-000000000001',
    'Block spam content',
    false,
    'SPAM',
    '{"dupe_limit": 5, "dupe_window_ms": 10000, "rate_limit": 10, "rate_window_ms": 30000}',
    '[{"type":"BLOCK"},{"type":"ALERT"}]',
    '{}',
    '{}'
  ),
  (
    '10000000-automod-0000-0000-000000000002',
    'Block flagged words',
    false,
    'KEYWORD_PRESET',
    '{"presets": ["PROFANITY", "SEXUAL_CONTENT", "SLURS"], "allow_list": ["ass", "damn", "fuck", "hell", "shit"]}',
    '[{"type":"BLOCK"},{"type":"ALERT"}]',
    '{}',
    '{}'
  ),
  (
    '10000000-automod-0000-0000-000000000003',
    'Block mention spam',
    false,
    'MENTION_SPAM',
    '{"mention_total_limit": 20}',
    '[{"type":"BLOCK"},{"type":"ALERT"}]',
    '{}',
    '{}'
  )
ON CONFLICT ("id") DO NOTHING;

-- Seed mod_log_channel_id in moderation_settings (default: #vault-security)
INSERT INTO "moderation_settings" ("key", "value", "updated_at")
VALUES ('mod_log_channel_id', '1509345764654977035', NOW())
ON CONFLICT ("key") DO NOTHING;
