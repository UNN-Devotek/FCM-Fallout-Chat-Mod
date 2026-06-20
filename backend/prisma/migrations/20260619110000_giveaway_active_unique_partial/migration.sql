-- Partial unique index: one active giveaway per user at a time.
-- This closes the TOCTOU race between the count() check and create() in
-- createGiveaway() — the DB enforces the constraint atomically regardless
-- of concurrent requests.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'giveaways_one_active_per_user' AND n.nspname = 'public'
  ) THEN
    CREATE UNIQUE INDEX "giveaways_one_active_per_user"
      ON "giveaways" ("created_by_user_id")
      WHERE (status = 'active');
  END IF;
END $$;
