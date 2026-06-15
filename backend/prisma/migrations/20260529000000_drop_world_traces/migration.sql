-- Drop world_traces table — world-trace telemetry retired.
-- Idempotent: IF EXISTS guard prevents errors on re-deploy.
DROP TABLE IF EXISTS "world_traces";
