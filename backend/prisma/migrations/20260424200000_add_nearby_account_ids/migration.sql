-- Track C3: nearbyAccountIds as a third same-server overlap dimension.
-- Some FO76 installs end up with both null serverEndpoint (only :3000
-- matchmake IPs in memory, filtered out) AND nearbyPlayers-overlap
-- below the NAMESET_MIN_OVERLAP threshold (sparse world, stale
-- snapshot, BA2 mod not on one side). FO76 keeps accountIds in memory
-- for recently-interacted peers even after they leave visual range,
-- giving a broader and stickier "was near this peer" signal.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "nearby_account_ids" TEXT[] NOT NULL DEFAULT '{}';
