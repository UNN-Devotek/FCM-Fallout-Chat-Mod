-- Idempotent: safe to run multiple times
CREATE TABLE IF NOT EXISTS "chat_commands" (
    "id"                SERIAL PRIMARY KEY,
    "trigger"           TEXT NOT NULL,
    "description"       TEXT NOT NULL DEFAULT '',
    "response"          TEXT NOT NULL DEFAULT '',
    "action_type"       TEXT NOT NULL DEFAULT 'message',
    "target_channel_id" UUID,
    "cooldown_sec"      INTEGER NOT NULL DEFAULT 0,
    "enabled"           BOOLEAN NOT NULL DEFAULT true,
    "requires_args"     BOOLEAN NOT NULL DEFAULT false,
    "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "chat_commands_trigger_key" ON "chat_commands" ("trigger");
CREATE INDEX IF NOT EXISTS "chat_commands_enabled_idx" ON "chat_commands" ("enabled");
