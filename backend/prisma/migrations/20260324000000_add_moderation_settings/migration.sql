-- CreateTable
CREATE TABLE "moderation_settings" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "moderation_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "moderation_settings_key_key" ON "moderation_settings"("key");

-- Seed defaults
INSERT INTO "moderation_settings" ("key", "value", "updated_at") VALUES
  ('spam_message_limit', '6', NOW()),
  ('spam_window_ms', '10000', NOW());
