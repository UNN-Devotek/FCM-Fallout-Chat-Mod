-- Keep the optional HUD package metadata with the release record so the
-- website, Discord announcement, and GitHub mirror all use the same artifact.
ALTER TABLE "releases"
  ADD COLUMN IF NOT EXISTS "hud_mod_version" TEXT,
  ADD COLUMN IF NOT EXISTS "hud_mod_url" TEXT;
