-- Migration: 20260604020000_add_wiki_images_locations
-- Adds wiki_images table (multi-image carousel + map images) and locations
-- column on wiki_entries. Both are idempotent.

-- -------------------------------------------------------------------------
-- wiki_images — one row per image associated with a wiki entry.
-- Primary image has position=0; map overlays have is_map=true.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wiki_images (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  wiki_entry_id  UUID        NOT NULL REFERENCES wiki_entries(id) ON DELETE CASCADE,
  url            TEXT        NOT NULL,
  source_url     TEXT,
  mime           TEXT,
  width          INTEGER,
  height         INTEGER,
  aspect         TEXT,
  position       INTEGER     NOT NULL DEFAULT 0,
  is_map         BOOLEAN     NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wiki_images_entry_position_idx
  ON wiki_images (wiki_entry_id, position);

-- -------------------------------------------------------------------------
-- wiki_entries.locations — JSON array of spawn/find location strings.
-- e.g. ["Whitespring Resort", "Grafton Dam"]
-- -------------------------------------------------------------------------
ALTER TABLE wiki_entries
  ADD COLUMN IF NOT EXISTS locations JSONB NOT NULL DEFAULT '[]'::jsonb;
