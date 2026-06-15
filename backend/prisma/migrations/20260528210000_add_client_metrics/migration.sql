-- Migration: add client_metrics table for desktop-client self-reported performance telemetry.
-- IDEMPOTENT: uses CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS
-- per project convention (see CLAUDE.md "Prisma Migrations MUST Be Idempotent").

CREATE TABLE IF NOT EXISTS "client_metrics" (
  "id"             UUID        NOT NULL DEFAULT gen_random_uuid(),
  "install_token"  TEXT        NOT NULL,
  "source"         TEXT        NOT NULL,        -- 'overlay' | 'monitor'
  "sampled_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "app_version"    TEXT        NOT NULL,
  "working_set_mb" INTEGER     NOT NULL,
  "gc_heap_mb"     INTEGER     NOT NULL,
  "cpu_pct"        REAL        NOT NULL,        -- 0..100
  "gif_cache_mb"   INTEGER,                     -- overlay only; NULL for monitor
  "fps"            REAL,                        -- overlay only; NULL for monitor

  CONSTRAINT "client_metrics_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "client_metrics_sampled_at_idx"
  ON "client_metrics" ("sampled_at" DESC);

CREATE INDEX IF NOT EXISTS "client_metrics_install_token_sampled_at_idx"
  ON "client_metrics" ("install_token", "sampled_at" DESC);

CREATE INDEX IF NOT EXISTS "client_metrics_source_sampled_at_idx"
  ON "client_metrics" ("source", "sampled_at" DESC);
