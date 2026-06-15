-- v1.0.36: fallback same-server grouping by player-list overlap.
-- Some FO76 installs (observed on a secondary account) never cache a world
-- :3001+ endpoint anywhere our scanner can reach — only the :3000 matchmake
-- IP. With the :3000 filter in place, those users end up with null endpoint
-- and can't be grouped by IP. Store each user's last nearbyPlayers snapshot
-- so the same-server predicate can fall back to name-set intersection.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "nearby_players" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "nearby_players_at" TIMESTAMPTZ;
