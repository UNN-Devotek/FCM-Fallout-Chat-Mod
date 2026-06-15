-- Add rev_id column to wiki_entries for fast skip (no wikitext fetch when revId unchanged)
-- Idempotent: IF NOT EXISTS guard (baseline-migrations.sh runs db push before migrate deploy)
ALTER TABLE wiki_entries ADD COLUMN IF NOT EXISTS rev_id integer;
