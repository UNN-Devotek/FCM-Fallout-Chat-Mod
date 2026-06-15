-- Saved Discord role IDs we stripped from a user at ban time, restored on
-- unban / ban expiry. Used by moderationActionsService Discord propagation.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "saved_discord_roles" JSONB;
