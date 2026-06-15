-- Block list: table, unique constraint, indexes, FK constraints.
-- Idempotent: CREATE TABLE IF NOT EXISTS, CREATE [UNIQUE] INDEX IF NOT EXISTS,
-- FK/unique constraints in DO $$ … IF NOT EXISTS (pg_constraint) … $$.

-- ── blocks ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "blocks" (
  "id"         UUID           NOT NULL DEFAULT gen_random_uuid(),
  "blocker_id" UUID           NOT NULL,
  "blocked_id" UUID           NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "blocks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "blocks_blocker_id_blocked_id_key" ON "blocks" ("blocker_id", "blocked_id");
CREATE INDEX IF NOT EXISTS        "blocks_blocker_id_idx"             ON "blocks" ("blocker_id");
CREATE INDEX IF NOT EXISTS        "blocks_blocked_id_idx"             ON "blocks" ("blocked_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blocks_blocker_id_fkey') THEN
    ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocker_id_fkey"
      FOREIGN KEY ("blocker_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blocks_blocked_id_fkey') THEN
    ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocked_id_fkey"
      FOREIGN KEY ("blocked_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
END $$;
