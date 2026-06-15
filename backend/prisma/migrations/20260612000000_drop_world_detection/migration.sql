-- Drop world detection tables and columns (retired feature, v1.3.30+)

-- CASCADE is required: world_sessions is still referenced by FKs from
-- server_messages and users.world_session_id at this point. Without CASCADE the
-- table drop fails (Postgres 2BP01 "other objects depend on it") on any DB that
-- has the feature's data — i.e. prod. CASCADE drops the lingering FK constraints;
-- the columns themselves are removed by the ALTER ... DROP COLUMN statements below.
DROP TABLE IF EXISTS "server_messages" CASCADE;
DROP TABLE IF EXISTS "world_sessions" CASCADE;

ALTER TABLE "users" DROP COLUMN IF EXISTS "server_endpoint";
ALTER TABLE "users" DROP COLUMN IF EXISTS "alternate_endpoints";
ALTER TABLE "users" DROP COLUMN IF EXISTS "nearby_players";
ALTER TABLE "users" DROP COLUMN IF EXISTS "nearby_account_ids";
ALTER TABLE "users" DROP COLUMN IF EXISTS "world_session_id";
