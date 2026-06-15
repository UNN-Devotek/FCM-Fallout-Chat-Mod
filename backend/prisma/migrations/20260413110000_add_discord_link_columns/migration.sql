ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "discord_id_link" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "discord_username" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "discord_avatar" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "users_discord_id_link_key" ON "users"("discord_id_link");
