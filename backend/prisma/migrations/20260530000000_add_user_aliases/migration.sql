-- CreateTable: user_aliases — idempotent (safe to re-run)
CREATE TABLE IF NOT EXISTS "user_aliases" (
  "id"         UUID        NOT NULL DEFAULT gen_random_uuid(),
  "user_id"    UUID        NOT NULL,
  "alias"      TEXT        NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "user_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: (user_id, alias) unique
CREATE UNIQUE INDEX IF NOT EXISTS "user_aliases_user_id_alias_key"
  ON "user_aliases"("user_id", "alias");

-- CreateIndex: (user_id, created_at desc) for ordered alias lookups
CREATE INDEX IF NOT EXISTS "user_aliases_user_id_created_at_idx"
  ON "user_aliases"("user_id", "created_at" DESC);

-- AddForeignKey: user_aliases.user_id -> users.id (ON DELETE CASCADE)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_aliases_user_id_fkey'
  ) THEN
    ALTER TABLE "user_aliases"
      ADD CONSTRAINT "user_aliases_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
END $$;
