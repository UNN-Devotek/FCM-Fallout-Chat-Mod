-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "server_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "content" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "server_endpoint" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "server_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "messages_server_endpoint_idx" ON "server_messages"("server_endpoint", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "server_messages_user_id_created_at_idx" ON "server_messages"("user_id", "created_at" DESC);

-- Add FK only if missing
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'server_messages_user_id_fkey'
    ) THEN
        ALTER TABLE "server_messages" ADD CONSTRAINT "server_messages_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
