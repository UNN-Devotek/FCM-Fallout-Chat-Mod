-- AI content moderation (OpenAI Moderation API).
--
-- Adds severity to automod violations. Keyword rules only ever had a boolean
-- "matched", so there was no way to sort a violation queue by how bad something
-- was; AI_MODERATION rules record the full category→score map plus the peak
-- score. Both columns are NULL for every non-AI trigger type.
--
-- Idempotent per the migrations hard rule: baseline-migrations.sh runs
-- `db push` before `migrate deploy`, so these may already exist.
ALTER TABLE "automod_violations"
  ADD COLUMN IF NOT EXISTS "ai_categories" JSONB,
  ADD COLUMN IF NOT EXISTS "ai_max_score" DOUBLE PRECISION;

-- Sort the violations queue by severity (highest first). Partial: only AI rows
-- populate the column, so the index stays small.
CREATE INDEX IF NOT EXISTS "automod_violations_ai_max_score_idx"
  ON "automod_violations" ("ai_max_score" DESC)
  WHERE "ai_max_score" IS NOT NULL;

-- Runtime configuration. Ships DISABLED and in shadow mode: enabling is a
-- deliberate admin action, and the first enable must not enforce untuned
-- thresholds against live chat.
--
-- ON CONFLICT DO NOTHING so re-running never clobbers an admin's tuning.
-- "updated_at" is Prisma @updatedAt (app-layer, no DB default) and NOT NULL, so
-- raw SQL must supply it.
INSERT INTO "moderation_settings" ("key", "value", "updated_at")
VALUES
  ('ai_moderation_enabled', 'false', NOW()),
  ('ai_moderation_mode', 'shadow', NOW())
ON CONFLICT ("key") DO NOTHING;
