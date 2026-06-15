-- Migration: add world_traces table for opt-in desktop telemetry uploads.
-- IDEMPOTENT: uses CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS
-- per project convention (see CLAUDE.md "Prisma Migrations MUST Be Idempotent").
--
-- Retention: rows older than 30 days are purged by the world-trace cleanup cron
-- job registered in backend/src/server.ts (see "World-trace cleanup" comment).

CREATE TABLE IF NOT EXISTS "world_traces" (
  "id"                  UUID        NOT NULL DEFAULT gen_random_uuid(),
  "user_id"             UUID        NOT NULL,
  "install_token"       TEXT        NOT NULL,
  "uploaded_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "session_started_at"  TIMESTAMPTZ,
  "session_ended_at"    TIMESTAMPTZ,
  "client_version"      TEXT        NOT NULL DEFAULT '',
  "size_bytes"          INTEGER     NOT NULL DEFAULT 0,
  "payload"             BYTEA       NOT NULL,

  CONSTRAINT "world_traces_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'world_traces_user_id_fkey'
  ) THEN
    ALTER TABLE "world_traces"
      ADD CONSTRAINT "world_traces_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "world_traces_user_id_uploaded_at_idx"
  ON "world_traces" ("user_id", "uploaded_at" DESC);
