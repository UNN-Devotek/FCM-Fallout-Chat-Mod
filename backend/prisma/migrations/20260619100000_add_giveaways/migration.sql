-- CreateTable: giveaways
CREATE TABLE IF NOT EXISTS "giveaways" (
    "id"                  UUID        NOT NULL DEFAULT gen_random_uuid(),
    "short_id"            TEXT        NOT NULL,
    "created_by_user_id"  UUID        NOT NULL,
    "creator_name"        TEXT        NOT NULL,
    "channel_id"          UUID        NOT NULL,
    "item_name"           TEXT        NOT NULL,
    "duration_min"        INTEGER     NOT NULL,
    "ends_at"             TIMESTAMPTZ(6) NOT NULL,
    "status"              TEXT        NOT NULL DEFAULT 'active',
    "winner_id"           UUID,
    "winner_name"         TEXT,
    "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "giveaways_pkey" PRIMARY KEY ("id")
);

-- CreateTable: giveaway_entries
CREATE TABLE IF NOT EXISTS "giveaway_entries" (
    "id"           UUID        NOT NULL DEFAULT gen_random_uuid(),
    "giveaway_id"  UUID        NOT NULL,
    "user_id"      UUID        NOT NULL,
    "username"     TEXT        NOT NULL,
    "joined_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "giveaway_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: unique short_id
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'giveaways_short_id_key' AND n.nspname = 'public'
  ) THEN
    ALTER TABLE "giveaways" ADD CONSTRAINT "giveaways_short_id_key" UNIQUE ("short_id");
  END IF;
END $$;

-- CreateIndex: giveaways(status, ends_at)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'giveaways_status_ends_at_idx' AND n.nspname = 'public'
  ) THEN
    CREATE INDEX "giveaways_status_ends_at_idx" ON "giveaways"("status", "ends_at");
  END IF;
END $$;

-- CreateIndex: giveaway_entries(giveaway_id, user_id) unique
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'giveaway_entries_giveaway_id_user_id_key' AND n.nspname = 'public'
  ) THEN
    ALTER TABLE "giveaway_entries"
      ADD CONSTRAINT "giveaway_entries_giveaway_id_user_id_key" UNIQUE ("giveaway_id", "user_id");
  END IF;
END $$;

-- CreateIndex: giveaway_entries(user_id)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'giveaway_entries_user_id_idx' AND n.nspname = 'public'
  ) THEN
    CREATE INDEX "giveaway_entries_user_id_idx" ON "giveaway_entries"("user_id");
  END IF;
END $$;

-- AddForeignKey: giveaways.created_by_user_id → users.id
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'giveaways_created_by_user_id_fkey'
  ) THEN
    ALTER TABLE "giveaways"
      ADD CONSTRAINT "giveaways_created_by_user_id_fkey"
      FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- AddForeignKey: giveaways.winner_id → users.id
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'giveaways_winner_id_fkey'
  ) THEN
    ALTER TABLE "giveaways"
      ADD CONSTRAINT "giveaways_winner_id_fkey"
      FOREIGN KEY ("winner_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- AddForeignKey: giveaway_entries.giveaway_id → giveaways.id
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'giveaway_entries_giveaway_id_fkey'
  ) THEN
    ALTER TABLE "giveaway_entries"
      ADD CONSTRAINT "giveaway_entries_giveaway_id_fkey"
      FOREIGN KEY ("giveaway_id") REFERENCES "giveaways"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- AddForeignKey: giveaway_entries.user_id → users.id
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'giveaway_entries_user_id_fkey'
  ) THEN
    ALTER TABLE "giveaway_entries"
      ADD CONSTRAINT "giveaway_entries_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
END $$;
