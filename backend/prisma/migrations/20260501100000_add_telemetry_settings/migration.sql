-- Migration: add telemetry_settings table for remote per-user and global telemetry control.
-- IDEMPOTENT: uses CREATE TABLE IF NOT EXISTS, CREATE UNIQUE INDEX IF NOT EXISTS,
-- and ON CONFLICT DO NOTHING per project convention (see CLAUDE.md).

CREATE TABLE IF NOT EXISTS "telemetry_settings" (
  "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
  "scope"       TEXT        NOT NULL,
  "enabled"     BOOLEAN     NOT NULL,
  "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_by"  TEXT,

  CONSTRAINT "telemetry_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "telemetry_settings_scope_key"
  ON "telemetry_settings" ("scope");

-- Seed the global default: enabled=true (dev-mode default).
-- ON CONFLICT DO NOTHING so reruns are safe.
INSERT INTO "telemetry_settings" ("id", "scope", "enabled", "updated_by")
VALUES (
  '00000000-0000-0000-0000-000000000099',
  'global',
  true,
  'system'
)
ON CONFLICT ("scope") DO NOTHING;
