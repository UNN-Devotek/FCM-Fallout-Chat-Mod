-- Add per-party member limit (nullable = unlimited). Idempotent.
ALTER TABLE "parties" ADD COLUMN IF NOT EXISTS "max_members" INTEGER;
