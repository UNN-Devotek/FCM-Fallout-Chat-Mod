-- Add an explicit colour choice for the immutable supporter star.
--
-- IDEMPOTENCY (HARD RULE): the hosted baseline runs `prisma db push` before
-- `migrate deploy`, so this is safe when the column already exists.

ALTER TABLE "user_cosmetics"
  ADD COLUMN IF NOT EXISTS "star_color_preset_id" TEXT;
