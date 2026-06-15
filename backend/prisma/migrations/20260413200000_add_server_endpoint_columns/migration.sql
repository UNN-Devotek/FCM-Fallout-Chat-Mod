-- AddColumn: server_endpoint and server_seen_at to users table (idempotent)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "server_endpoint" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "server_seen_at" TIMESTAMPTZ(6);
CREATE INDEX IF NOT EXISTS "users_server_endpoint_idx" ON "users"("server_endpoint");
