-- Add involved_players to player_reports
ALTER TABLE player_reports ADD COLUMN IF NOT EXISTS involved_players TEXT;

-- Add image_urls to player_reports (JSON array of MinIO URLs)
ALTER TABLE player_reports ADD COLUMN IF NOT EXISTS image_urls TEXT;

-- Add discord_display_name to users (Discord global_name, separate from username handle)
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_display_name TEXT;
