-- Add wiki catalog tables: wiki_entries, wiki_aliases, wiki_ingest_errors.
-- Idempotent: all DDL uses IF NOT EXISTS guards; constraints use DO $$ guards.
-- pg_trgm extension MUST be the first statement (may require superuser on first install).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS wiki_entries (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  wiki_title       TEXT        NOT NULL,
  page_id          INTEGER     NOT NULL,          -- Fandom numeric id; stable across renames → UPSERT KEY
  name             TEXT        NOT NULL,           -- normalized display name ("(Fallout 76)" stripped)
  kind             TEXT,                           -- weapon|armor|power_armor|creature|item|location|perk|character|other
  infobox          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  image_url        TEXT,                           -- our MinIO-proxied URL
  image_mime       TEXT,                           -- 'image/webp' (CDN serves WebP even for .png)
  image_width      INTEGER,
  image_height     INTEGER,
  image_aspect     TEXT,                           -- 'ultrawide'|'portrait'|'square'|'unknown' (UI layout)
  image_source_url TEXT,                           -- Fandom CDN fallback
  content_hash     CHAR(64),                       -- sha256(raw wikitext) → change detection
  -- embedding     VECTOR(1536),                   -- reserved for P4 (kept commented until pgvector installed)
  is_stale         BOOLEAN     NOT NULL DEFAULT false,
  ingested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS wiki_entries_page_id_idx     ON wiki_entries (page_id);
CREATE INDEX        IF NOT EXISTS wiki_entries_name_trgm_idx   ON wiki_entries USING gin(name gin_trgm_ops);
CREATE INDEX        IF NOT EXISTS wiki_entries_kind_idx        ON wiki_entries (kind);
CREATE INDEX        IF NOT EXISTS wiki_entries_infobox_gin_idx ON wiki_entries USING gin(infobox jsonb_path_ops);

CREATE TABLE IF NOT EXISTS wiki_aliases (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  alias         TEXT        NOT NULL,
  wiki_entry_id UUID        NOT NULL REFERENCES wiki_entries(id) ON DELETE CASCADE,
  source        TEXT        NOT NULL DEFAULT 'auto',  -- 'auto' (derived) | 'curated' (human)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS wiki_aliases_alias_entry_idx ON wiki_aliases (alias, wiki_entry_id);
CREATE INDEX        IF NOT EXISTS wiki_aliases_alias_trgm_idx  ON wiki_aliases USING gin(alias gin_trgm_ops);
CREATE INDEX        IF NOT EXISTS wiki_aliases_entry_idx       ON wiki_aliases (wiki_entry_id);

CREATE TABLE IF NOT EXISTS wiki_ingest_errors (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id      INTEGER     NOT NULL,
  error        TEXT        NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wiki_ingest_errors_page_id_idx      ON wiki_ingest_errors (page_id);
CREATE INDEX IF NOT EXISTS wiki_ingest_errors_attempted_at_idx ON wiki_ingest_errors (attempted_at DESC);
