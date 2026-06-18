-- Discord "lockdown" thread mapping for player reports filed from the Discord
-- panel. Lets the bot attach screenshots dropped in the thread to the report.
-- Idempotent (IF NOT EXISTS) — safe under baseline-migrations.sh.

ALTER TABLE player_reports ADD COLUMN IF NOT EXISTS discord_thread_id TEXT;

CREATE INDEX IF NOT EXISTS player_reports_discord_thread_id_idx
  ON player_reports (discord_thread_id);
