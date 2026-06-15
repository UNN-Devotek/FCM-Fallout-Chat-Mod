-- Migration: add_camp_items
-- Idempotent: uses IF NOT EXISTS throughout.
-- Table stores CAMP item records ingested from the 76-CAMPDatabase JSON.

CREATE TABLE IF NOT EXISTS camp_items (
  id           TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  name         TEXT        NOT NULL,
  category     TEXT        NOT NULL,
  sub_category TEXT        NOT NULL,
  budget_cost  DOUBLE PRECISION,
  plan         TEXT,
  form_id      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT camp_items_pkey PRIMARY KEY (id)
);

-- Unique constraint for upsert deduplication by name + form_id
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'camp_items_name_form_id_key'
  ) THEN
    ALTER TABLE camp_items ADD CONSTRAINT camp_items_name_form_id_key UNIQUE (name, form_id);
  END IF;
END $$;

-- Case-insensitive name index for fast search
CREATE INDEX IF NOT EXISTS camp_items_name_lower_idx ON camp_items (lower(name));

-- Index for category browsing
CREATE INDEX IF NOT EXISTS camp_items_category_idx ON camp_items (category);
