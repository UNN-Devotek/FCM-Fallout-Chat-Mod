-- Sequential case number for every player report (Discord + web).
-- The schema's @default(autoincrement()) is authoritative via `prisma db push`
-- (baseline-migrations.sh), which creates this column + its sequence and backfills
-- existing rows. This migration is an idempotent safety net for migrate-deploy
-- paths: SERIAL creates player_reports_report_number_seq, backfills existing rows,
-- and is NOT NULL — matching what db push produces (so no default/sequence clash).

ALTER TABLE player_reports ADD COLUMN IF NOT EXISTS report_number SERIAL;
CREATE UNIQUE INDEX IF NOT EXISTS player_reports_report_number_key ON player_reports (report_number);
