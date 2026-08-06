-- Supporter tier + name/colour cosmetics (epic #223)
--
-- IDEMPOTENCY (HARD RULE): baseline-migrations.sh runs `prisma db push` BEFORE
-- `migrate deploy`, so every statement here must tolerate the objects already
-- existing. Uses IF NOT EXISTS everywhere it is available, and the DO $$ ... END $$
-- catalog guard for constraints (which have no IF NOT EXISTS form).
--
-- Raw SQL must set updated_at explicitly — Prisma's @updatedAt is applied in the
-- application layer, not by a database trigger.

-- ── user_cosmetics ──────────────────────────────────────────────────────────
-- 1:1 with users, kept OFF the hot users row (cosmetics are read rarely and
-- Redis-cached; users is touched by every auth check). Most users have no row,
-- which is the default-identity state.
CREATE TABLE IF NOT EXISTS "user_cosmetics" (
    "user_id"                 UUID         NOT NULL,
    "custom_display_name"     TEXT,
    "color_preset_id"         TEXT,
    "custom_color_hex"        TEXT,
    "effect_id"               TEXT,
    "custom_tag"              TEXT,
    "cosmetics_enabled"       BOOLEAN      NOT NULL DEFAULT true,
    "display_name_changed_at" TIMESTAMPTZ(6),
    "created_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "user_cosmetics_pkey" PRIMARY KEY ("user_id")
);

-- FK user_cosmetics.user_id -> users.id, cascade so a deleted account takes its
-- cosmetics with it (GDPR-adjacent: no orphaned display names left behind).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'user_cosmetics_user_id_fkey' AND n.nspname = 'public'
  ) THEN
    ALTER TABLE "user_cosmetics"
      ADD CONSTRAINT "user_cosmetics_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ── supporter_entitlements ──────────────────────────────────────────────────
-- Keyed by discord_id (like admin_users): the entitlement signal arrives from
-- Discord and may exist before, or entirely without, a linked FCM user row.
--
-- NOT stored in admin_users on purpose — that table is reserved for elevated staff
-- identities and isPrivilegedRole() must keep returning false for supporters.
--
-- Lapsed rows are RETAINED rather than deleted: the entitlement survives a user
-- leaving the Discord so privileges restore on rejoin without re-purchasing.
CREATE TABLE IF NOT EXISTS "supporter_entitlements" (
    "id"               SERIAL       NOT NULL,
    "discord_id"       TEXT         NOT NULL,
    -- 'supporter' | 'overseer'
    "tier"             TEXT         NOT NULL,
    -- 'discord_sub' | 'patreon' | 'stripe' | 'manual' — keeps the payment provider
    -- swappable; changing providers becomes a new adapter, not a schema rewrite.
    "source"           TEXT         NOT NULL DEFAULT 'manual',
    "external_id"      TEXT,
    -- 'active' | 'lapsed' | 'cancelled'
    "status"           TEXT         NOT NULL DEFAULT 'active',
    "granted_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "last_verified_at" TIMESTAMPTZ(6),
    "expires_at"       TIMESTAMPTZ(6),
    "notes"            TEXT,
    "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "supporter_entitlements_pkey" PRIMARY KEY ("id")
);

-- One entitlement per Discord account.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'supporter_entitlements_discord_id_key' AND n.nspname = 'public'
  ) THEN
    ALTER TABLE "supporter_entitlements"
      ADD CONSTRAINT "supporter_entitlements_discord_id_key" UNIQUE ("discord_id");
  END IF;
END $$;

-- The reconcile job sweeps by status.
CREATE INDEX IF NOT EXISTS "supporter_entitlements_status_idx"
  ON "supporter_entitlements"("status");
