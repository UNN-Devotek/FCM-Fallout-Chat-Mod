-- Add online_snapshots table for recording periodic player-online counts.
-- Idempotent: all DDL uses IF NOT EXISTS guards.

CREATE TABLE IF NOT EXISTS "online_snapshots" (
  "id"           BIGSERIAL PRIMARY KEY,
  "captured_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "online_count" INTEGER     NOT NULL
);

CREATE INDEX IF NOT EXISTS "online_snapshots_captured_at_idx"
  ON "online_snapshots" ("captured_at");
