-- Discord embed templates built in the dashboard and posted by the bot.
-- Idempotent (baseline-migrations.sh re-runs after db push).
CREATE TABLE IF NOT EXISTS "discord_embeds" (
  "id"         SERIAL NOT NULL,
  "name"       TEXT NOT NULL,
  "data"       JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "discord_embeds_pkey" PRIMARY KEY ("id")
);
