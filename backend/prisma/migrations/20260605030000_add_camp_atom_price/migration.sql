-- Migration: add Atomic Shop price fields to camp_items
-- Idempotent: uses IF NOT EXISTS guards throughout

ALTER TABLE camp_items ADD COLUMN IF NOT EXISTS atom_price       integer       NULL;
ALTER TABLE camp_items ADD COLUMN IF NOT EXISTS atom_bundle      text          NULL;
ALTER TABLE camp_items ADD COLUMN IF NOT EXISTS atom_checked_at  timestamptz   NULL;
