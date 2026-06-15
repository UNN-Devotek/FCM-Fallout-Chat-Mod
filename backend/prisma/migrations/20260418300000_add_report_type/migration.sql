ALTER TABLE player_reports ADD COLUMN IF NOT EXISTS report_type TEXT NOT NULL DEFAULT 'player';
