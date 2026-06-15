-- Temp "join-to-create" voice channels: persist owner so empty orphans can be
-- swept on bot restart. Idempotent (baseline-migrations.sh re-runs after db push).
CREATE TABLE IF NOT EXISTS "temp_voice_channels" (
  "discord_channel_id" TEXT NOT NULL,
  "guild_id"           TEXT NOT NULL,
  "owner_id"           TEXT NOT NULL,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "temp_voice_channels_pkey" PRIMARY KEY ("discord_channel_id")
);
