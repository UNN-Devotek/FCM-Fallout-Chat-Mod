-- Add parent_id and sort_order to channels for hierarchical navigation (idempotent)
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "parent_id" UUID;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "sort_order" INTEGER NOT NULL DEFAULT 0;

-- Self-referential FK (skip if exists)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channels_parent_id_fkey') THEN
    ALTER TABLE "channels" ADD CONSTRAINT "channels_parent_id_fkey"
      FOREIGN KEY ("parent_id") REFERENCES "channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Index for fast child lookups (skip if exists)
CREATE INDEX IF NOT EXISTS "channels_parent_id_idx" ON "channels"("parent_id");
