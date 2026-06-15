-- Party system: enums, tables, indexes, FK constraints.
-- Idempotent: CREATE TYPE guarded by pg_type, CREATE TABLE IF NOT EXISTS,
-- CREATE [UNIQUE] INDEX IF NOT EXISTS, FK constraints in DO $$ … IF NOT EXISTS (pg_constraint) … $$.

-- ── enums ──────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'party_reap_policy') THEN
    CREATE TYPE "party_reap_policy" AS ENUM ('persistent', 'ephemeral');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'party_role') THEN
    CREATE TYPE "party_role" AS ENUM ('owner', 'comod', 'member');
  END IF;
END $$;

-- ── parties ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "parties" (
  "id"               UUID            NOT NULL DEFAULT gen_random_uuid(),
  "name"             TEXT            NOT NULL,
  "color"            TEXT            NOT NULL DEFAULT '#18FF62',
  "is_private"       BOOLEAN         NOT NULL DEFAULT FALSE,
  "reap_policy"      "party_reap_policy" NOT NULL DEFAULT 'persistent',
  "owner_id"         UUID            NOT NULL,
  "last_message_at"  TIMESTAMPTZ(6),
  "recent_msg_count" INTEGER         NOT NULL DEFAULT 0,
  "is_deleted"       BOOLEAN         NOT NULL DEFAULT FALSE,
  "created_at"       TIMESTAMPTZ(6)  NOT NULL DEFAULT NOW(),
  "updated_at"       TIMESTAMPTZ(6)  NOT NULL DEFAULT NOW(),
  CONSTRAINT "parties_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "parties_is_private_is_deleted_idx"  ON "parties" ("is_private", "is_deleted");
CREATE INDEX IF NOT EXISTS "parties_last_message_at_idx"        ON "parties" ("last_message_at" DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parties_owner_id_fkey') THEN
    ALTER TABLE "parties" ADD CONSTRAINT "parties_owner_id_fkey"
      FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT;
  END IF;
END $$;

-- ── party_members ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "party_members" (
  "id"        UUID            NOT NULL DEFAULT gen_random_uuid(),
  "party_id"  UUID            NOT NULL,
  "user_id"   UUID            NOT NULL,
  "role"      "party_role"    NOT NULL DEFAULT 'member',
  "joined_at" TIMESTAMPTZ(6)  NOT NULL DEFAULT NOW(),
  CONSTRAINT "party_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "party_members_party_id_user_id_key" ON "party_members" ("party_id", "user_id");
CREATE INDEX IF NOT EXISTS        "party_members_user_id_idx"           ON "party_members" ("user_id");
CREATE INDEX IF NOT EXISTS        "party_members_party_id_role_idx"     ON "party_members" ("party_id", "role");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_members_party_id_fkey') THEN
    ALTER TABLE "party_members" ADD CONSTRAINT "party_members_party_id_fkey"
      FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_members_user_id_fkey') THEN
    ALTER TABLE "party_members" ADD CONSTRAINT "party_members_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- ── party_invites ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "party_invites" (
  "id"           UUID            NOT NULL DEFAULT gen_random_uuid(),
  "party_id"     UUID            NOT NULL,
  "invitee_id"   UUID            NOT NULL,
  "inviter_id"   UUID            NOT NULL,
  "status"       TEXT            NOT NULL DEFAULT 'pending',
  "created_at"   TIMESTAMPTZ(6)  NOT NULL DEFAULT NOW(),
  "responded_at" TIMESTAMPTZ(6),
  CONSTRAINT "party_invites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "party_invites_party_id_invitee_id_key" ON "party_invites" ("party_id", "invitee_id");
CREATE INDEX IF NOT EXISTS        "party_invites_invitee_id_status_idx"   ON "party_invites" ("invitee_id", "status");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_invites_party_id_fkey') THEN
    ALTER TABLE "party_invites" ADD CONSTRAINT "party_invites_party_id_fkey"
      FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_invites_invitee_id_fkey') THEN
    ALTER TABLE "party_invites" ADD CONSTRAINT "party_invites_invitee_id_fkey"
      FOREIGN KEY ("invitee_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_invites_inviter_id_fkey') THEN
    ALTER TABLE "party_invites" ADD CONSTRAINT "party_invites_inviter_id_fkey"
      FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- ── party_messages ────────────────────────────────────────────────────────────
-- Composite PK (id, created_at) mirrors the messages + audit_logs TimescaleDB pattern.
CREATE TABLE IF NOT EXISTS "party_messages" (
  "id"         UUID            NOT NULL DEFAULT gen_random_uuid(),
  "party_id"   UUID            NOT NULL,
  "user_id"    UUID            NOT NULL,
  "username"   TEXT            NOT NULL,
  "content"    TEXT            NOT NULL,
  "source"     TEXT            NOT NULL DEFAULT 'party',
  "is_deleted" BOOLEAN         NOT NULL DEFAULT FALSE,
  "created_at" TIMESTAMPTZ(6)  NOT NULL DEFAULT NOW(),
  CONSTRAINT "party_messages_pkey" PRIMARY KEY ("id", "created_at")
);

CREATE INDEX IF NOT EXISTS "party_messages_party_id_created_at_idx" ON "party_messages" ("party_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "party_messages_user_id_created_at_idx"  ON "party_messages" ("user_id",  "created_at" DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_messages_user_id_fkey') THEN
    ALTER TABLE "party_messages" ADD CONSTRAINT "party_messages_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
  END IF;
END $$;
