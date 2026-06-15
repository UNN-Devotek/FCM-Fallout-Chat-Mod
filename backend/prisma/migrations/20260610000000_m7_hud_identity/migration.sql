-- M7 two-way in-game chat: identity fields on users + HudIdentityBlock table.
-- Idempotent: all column additions use IF NOT EXISTS; table creation uses IF NOT EXISTS.
-- Runs after db push (baseline) + migrate deploy per the repo's migration strategy.

-- ── User identity fields ──────────────────────────────────────────────────────

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "identity_hash"      TEXT,
  ADD COLUMN IF NOT EXISTS "fo76_account_name"  TEXT,
  ADD COLUMN IF NOT EXISTS "fo76_character_name" TEXT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'users' AND indexname = 'users_identity_hash_key'
  ) THEN
    CREATE UNIQUE INDEX "users_identity_hash_key" ON "users" ("identity_hash");
  END IF;
END $$;

-- ── HUD identity blocks table ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "hud_identity_blocks" (
  "id"           UUID        NOT NULL DEFAULT gen_random_uuid(),
  "identity_hash" TEXT       NOT NULL,
  "type"          TEXT       NOT NULL,
  "reason"        TEXT,
  "created_by"    TEXT,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "expires_at"    TIMESTAMPTZ(6),
  CONSTRAINT "hud_identity_blocks_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'hud_identity_blocks' AND indexname = 'hud_identity_blocks_identity_hash_idx'
  ) THEN
    CREATE INDEX "hud_identity_blocks_identity_hash_idx" ON "hud_identity_blocks" ("identity_hash");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'hud_identity_blocks' AND indexname = 'hud_identity_blocks_type_idx'
  ) THEN
    CREATE INDEX "hud_identity_blocks_type_idx" ON "hud_identity_blocks" ("type");
  END IF;
END $$;
