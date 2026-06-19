-- Drop telemetry & client performance metrics (retired feature — privacy + simplification).
-- Neither table is referenced by any foreign key, so a plain idempotent drop is safe.
-- Idempotent: baseline-migrations.sh runs `db push` before `migrate deploy`.
DROP TABLE IF EXISTS "telemetry_settings" CASCADE;
DROP TABLE IF EXISTS "client_metrics" CASCADE;
