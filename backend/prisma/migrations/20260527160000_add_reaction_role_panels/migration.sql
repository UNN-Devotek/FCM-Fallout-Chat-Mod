-- Reaction-role panels: a bot-posted message whose reactions grant/remove roles.
-- Idempotent (baseline-migrations.sh re-runs after db push).
CREATE TABLE IF NOT EXISTS "reaction_role_panels" (
  "message_id" TEXT NOT NULL,
  "channel_id" TEXT NOT NULL,
  "guild_id"   TEXT NOT NULL,
  "mappings"   JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "reaction_role_panels_pkey" PRIMARY KEY ("message_id")
);
