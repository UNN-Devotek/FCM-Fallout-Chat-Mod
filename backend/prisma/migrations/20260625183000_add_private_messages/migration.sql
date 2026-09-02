CREATE TABLE IF NOT EXISTS "private_conversations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_a_id" UUID NOT NULL,
  "user_b_id" UUID NOT NULL,
  "user_a_last_read_at" TIMESTAMPTZ(6),
  "user_b_last_read_at" TIMESTAMPTZ(6),
  "last_message_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "private_conversations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "private_conversations_user_a_id_fkey"
    FOREIGN KEY ("user_a_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "private_conversations_user_b_id_fkey"
    FOREIGN KEY ("user_b_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "private_conversations_user_a_id_user_b_id_key"
  ON "private_conversations" ("user_a_id", "user_b_id");

CREATE INDEX IF NOT EXISTS "private_conversations_user_a_id_last_message_at_idx"
  ON "private_conversations" ("user_a_id", "last_message_at" DESC);

CREATE INDEX IF NOT EXISTS "private_conversations_user_b_id_last_message_at_idx"
  ON "private_conversations" ("user_b_id", "last_message_at" DESC);

CREATE TABLE IF NOT EXISTS "private_messages" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "conversation_id" UUID NOT NULL,
  "sender_id" UUID NOT NULL,
  "content" TEXT NOT NULL,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "private_messages_pkey" PRIMARY KEY ("id", "created_at"),
  CONSTRAINT "private_messages_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "private_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "private_messages_sender_id_fkey"
    FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "private_messages_conversation_id_created_at_idx"
  ON "private_messages" ("conversation_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "private_messages_sender_id_created_at_idx"
  ON "private_messages" ("sender_id", "created_at" DESC);
