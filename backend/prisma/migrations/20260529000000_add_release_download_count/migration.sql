-- Add download_count to releases table.
-- Idempotent: baseline-migrations.sh runs prisma db push before migrate deploy,
-- so the column may already exist when this migration runs.
ALTER TABLE "releases" ADD COLUMN IF NOT EXISTS "download_count" integer NOT NULL DEFAULT 0;
