-- Per-channel GIF and emoji enable/disable flags.
-- Idempotent (baseline-migrations.sh re-runs after db push).
-- GIFs OFF by default (GIF picker removed unless explicitly enabled per channel).
-- Emojis ON by default (emoji picker stays unless an admin disables it).
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "allow_gifs"    boolean NOT NULL DEFAULT false;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "allow_emojis"  boolean NOT NULL DEFAULT true;
