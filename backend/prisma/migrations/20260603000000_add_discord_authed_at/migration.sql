-- Add discord_authed_at: timestamp of the user's last Discord OAuth. The register
-- gate requires a Discord auth within the last 30 days; after that the overlay must
-- re-authenticate. Idempotent (safe to re-run after `prisma db push`).

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "discord_authed_at" timestamptz(6);

-- Grandfather existing linked users in with a fresh window so the gate does NOT
-- force every already-linked user to re-auth the moment this deploys. They keep
-- their session; their first re-auth is ~30 days out (or sooner if they relink).
UPDATE "users" SET "discord_authed_at" = now()
WHERE "discord_id_link" IS NOT NULL AND "discord_authed_at" IS NULL;
