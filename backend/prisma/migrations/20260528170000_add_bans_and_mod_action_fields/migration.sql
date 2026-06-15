-- Mod-action audit fields on users + full Ban/BanEvidence audit tables.
-- Idempotent: every change is `ADD COLUMN IF NOT EXISTS` or `CREATE TABLE IF NOT EXISTS`.

-- ── users: per-action expiry / actor / category columns ──────────────────────
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "banned_until"   TIMESTAMPTZ(6);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "banned_by_id"   UUID;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "banned_at"      TIMESTAMPTZ(6);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ban_category"   TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "kicked_until"   TIMESTAMPTZ(6);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "muted_by_id"    UUID;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mute_reason"    TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mute_category"  TEXT;

-- ── bans: full history (separate from the boolean flag) ─────────────────────
CREATE TABLE IF NOT EXISTS "bans" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"          UUID NOT NULL,
  "banned_by_id"     UUID NOT NULL,
  "reason_category"  TEXT NOT NULL,
  "reason_text"      TEXT NOT NULL,
  "banned_until"     TIMESTAMPTZ(6),
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "reversed_at"      TIMESTAMPTZ(6),
  "reversed_by_id"   UUID,
  "reverse_reason"   TEXT,
  CONSTRAINT "bans_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "bans_user_id_created_at_idx"  ON "bans" ("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "bans_reversed_at_idx"         ON "bans" ("reversed_at");
CREATE INDEX IF NOT EXISTS "bans_created_at_idx"          ON "bans" ("created_at" DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bans_user_id_fkey') THEN
    ALTER TABLE "bans" ADD CONSTRAINT "bans_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bans_banned_by_id_fkey') THEN
    ALTER TABLE "bans" ADD CONSTRAINT "bans_banned_by_id_fkey"
      FOREIGN KEY ("banned_by_id") REFERENCES "users"("id") ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bans_reversed_by_id_fkey') THEN
    ALTER TABLE "bans" ADD CONSTRAINT "bans_reversed_by_id_fkey"
      FOREIGN KEY ("reversed_by_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- ── ban_evidence: text + image rows per ban ─────────────────────────────────
CREATE TABLE IF NOT EXISTS "ban_evidence" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "ban_id"        UUID NOT NULL,
  "type"          TEXT NOT NULL,
  "text_content"  TEXT,
  "object_key"    TEXT,
  "mime"          TEXT,
  "size_bytes"    INTEGER,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "ban_evidence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ban_evidence_ban_id_idx" ON "ban_evidence" ("ban_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ban_evidence_ban_id_fkey') THEN
    ALTER TABLE "ban_evidence" ADD CONSTRAINT "ban_evidence_ban_id_fkey"
      FOREIGN KEY ("ban_id") REFERENCES "bans"("id") ON DELETE CASCADE;
  END IF;
END $$;
