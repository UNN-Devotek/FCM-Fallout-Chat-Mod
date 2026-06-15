-- Rename "temp voice" → "voice" throughout: table + ModerationSetting keys.
-- Idempotent — handles all three cases:
--   1. Fresh install: voice_channels created by Prisma db push, no old table, nothing to migrate.
--   2. Upgrade where db push already created voice_channels alongside old temp_voice_channels:
--      copy rows over (ON CONFLICT DO NOTHING) then drop the old table.
--   3. Re-run after migration already applied: temp_voice_channels gone, no-op.

CREATE TABLE IF NOT EXISTS "voice_channels" (
  "discord_channel_id" TEXT NOT NULL,
  "guild_id"           TEXT NOT NULL,
  "owner_id"           TEXT NOT NULL,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "voice_channels_pkey" PRIMARY KEY ("discord_channel_id")
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'temp_voice_channels'
  ) THEN
    INSERT INTO voice_channels (discord_channel_id, guild_id, owner_id, created_at)
    SELECT discord_channel_id, guild_id, owner_id, created_at FROM temp_voice_channels
    ON CONFLICT (discord_channel_id) DO NOTHING;
    DROP TABLE temp_voice_channels;
  END IF;
END $$;

-- Rename setting keys: tempvoice.enabled → voice.enabled, etc.
UPDATE moderation_settings
   SET key = 'voice.' || substring(key from length('tempvoice.') + 1)
 WHERE key LIKE 'tempvoice.%';
