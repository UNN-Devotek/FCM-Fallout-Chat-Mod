CREATE TABLE IF NOT EXISTS "discord_event_mirrors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "guild_id" TEXT NOT NULL,
    "scheduled_event_id" TEXT NOT NULL,
    "event_code" TEXT NOT NULL,
    "announcement_channel_id" TEXT NOT NULL,
    "announcement_message_id" TEXT,
    "fcm_message_id" TEXT,
    "announcement_url" TEXT,
    "generated_description_link" TEXT,
    "source_status" TEXT NOT NULL,
    "source_name" TEXT,
    "source_start_utc" TIMESTAMPTZ(6),
    "source_end_utc" TIMESTAMPTZ(6),
    "source_location" TEXT,
    "source_description_summary" TEXT,
    "source_discord_event_url" TEXT,
    "final_interested_count" INTEGER,
    "source_fingerprint" TEXT,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "discord_event_mirrors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "discord_event_mirrors_guild_id_scheduled_event_id_key"
  ON "discord_event_mirrors" ("guild_id", "scheduled_event_id");
CREATE UNIQUE INDEX IF NOT EXISTS "discord_event_mirrors_event_code_key"
  ON "discord_event_mirrors" ("event_code");
CREATE INDEX IF NOT EXISTS "discord_event_mirrors_guild_id_source_status_idx"
  ON "discord_event_mirrors" ("guild_id", "source_status");
CREATE INDEX IF NOT EXISTS "discord_event_mirrors_announcement_channel_id_announcement_message_id_idx"
  ON "discord_event_mirrors" ("announcement_channel_id", "announcement_message_id");

ALTER TABLE "discord_event_mirrors" ADD COLUMN IF NOT EXISTS "source_name" TEXT;
ALTER TABLE "discord_event_mirrors" ADD COLUMN IF NOT EXISTS "source_start_utc" TIMESTAMPTZ(6);
ALTER TABLE "discord_event_mirrors" ADD COLUMN IF NOT EXISTS "source_end_utc" TIMESTAMPTZ(6);
ALTER TABLE "discord_event_mirrors" ADD COLUMN IF NOT EXISTS "source_location" TEXT;
ALTER TABLE "discord_event_mirrors" ADD COLUMN IF NOT EXISTS "source_description_summary" TEXT;
ALTER TABLE "discord_event_mirrors" ADD COLUMN IF NOT EXISTS "source_discord_event_url" TEXT;

CREATE TABLE IF NOT EXISTS "discord_event_subscribers" (
    "mirror_id" UUID NOT NULL,
    "discord_user_id" TEXT NOT NULL,
    "linked_fcm_user_id" UUID,
    "subscribed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "discord_event_subscribers_pkey" PRIMARY KEY ("mirror_id", "discord_user_id"),
    CONSTRAINT "discord_event_subscribers_mirror_id_fkey"
      FOREIGN KEY ("mirror_id") REFERENCES "discord_event_mirrors" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "discord_event_subscribers_discord_user_id_idx"
  ON "discord_event_subscribers" ("discord_user_id");
CREATE INDEX IF NOT EXISTS "discord_event_subscribers_linked_fcm_user_id_idx"
  ON "discord_event_subscribers" ("linked_fcm_user_id");
