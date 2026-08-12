-- Free account-level chat name (not a supporter cosmetic).
--
-- IDEMPOTENCY (HARD RULE): baseline-migrations.sh runs `prisma db push` before
-- `migrate deploy`, so this migration tolerates the column already existing.
-- Keep the old cosmetic columns for now: db push must never drop them before the
-- backfill has run. A later dedicated cleanup migration can remove them safely.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "chat_name" TEXT;

-- Preserve an existing cosmetic custom name when moving it to the free,
-- account-level setting. This is deliberately conditional: fresh deployments and
-- older databases that never received the cosmetics table remain valid.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_cosmetics'
      AND column_name = 'custom_display_name'
  ) THEN
    UPDATE "users" AS u
    SET "chat_name" = uc."custom_display_name",
        "updated_at" = now()
    FROM "user_cosmetics" AS uc
    WHERE uc."user_id" = u."id"
      AND u."chat_name" IS NULL
      AND uc."custom_display_name" IS NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "users_chat_name_idx" ON "users"("chat_name");
