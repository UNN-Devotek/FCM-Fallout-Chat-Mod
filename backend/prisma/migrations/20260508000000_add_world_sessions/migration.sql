-- v1.1.56 (lock-in): cross-server chat pollution fix.
-- Replace endpoint-string equality as the grouping primitive with a
-- backend-minted worldSessionId (UUID FK). See A3 final plan in
-- _arcwright-output/research-2026-05-08/A3-final-plan.md.
--
-- This migration is fully ADDITIVE and IDEMPOTENT (per CLAUDE.md guidance
-- "Prisma Migrations MUST Be Idempotent"). No drops in this migration.
-- Cleanup of legacy endpoint-string columns is deferred to Phase 4 / a
-- later release after the new path has soaked.

-- ── world_sessions table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "world_sessions" (
  "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "endpoint_snapshot"  TEXT,
  "confidence"         TEXT NOT NULL DEFAULT 'provisional',
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "last_activity_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "ended_at"           TIMESTAMPTZ(6)
);
CREATE INDEX IF NOT EXISTS "world_sessions_endpoint_snapshot_idx" ON "world_sessions"("endpoint_snapshot");
CREATE INDEX IF NOT EXISTS "world_sessions_last_activity_at_idx" ON "world_sessions"("last_activity_at");
CREATE INDEX IF NOT EXISTS "world_sessions_ended_at_idx" ON "world_sessions"("ended_at");

-- ── users.world_session_id FK ───────────────────────────────────────────────
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "world_session_id" UUID;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_world_session_id_fkey') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_world_session_id_fkey"
      FOREIGN KEY ("world_session_id") REFERENCES "world_sessions"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "users_world_session_id_idx" ON "users"("world_session_id");

-- ── server_messages.world_session_id FK ─────────────────────────────────────
ALTER TABLE "server_messages" ADD COLUMN IF NOT EXISTS "world_session_id" UUID;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'server_messages_world_session_id_fkey') THEN
    ALTER TABLE "server_messages" ADD CONSTRAINT "server_messages_world_session_id_fkey"
      FOREIGN KEY ("world_session_id") REFERENCES "world_sessions"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "server_messages_world_session_id_created_at_idx"
  ON "server_messages"("world_session_id", "created_at" DESC);
