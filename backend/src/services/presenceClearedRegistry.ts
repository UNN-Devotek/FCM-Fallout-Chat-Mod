/**
 * presenceClearedRegistry.ts
 *
 * Tracks users who recently had their server presence explicitly cleared (endpoint
 * set to null via presence:update) so that stale player-list POSTs arriving in the
 * seconds/minutes after a genuine world-leave can't re-arm the name-overlap tier
 * and re-assign a virtual endpoint — which would put the user "back on" the server
 * in chat for up to 2 minutes after they left.
 *
 * Both handlers.ts (writes markRecentlyCleared on explicit leave) and
 * playerList.ts (reads isRecentlyCleared before nearbyPlayers write) import this
 * module. The Map is tiny in practice (one entry per connected user who just left),
 * so no LRU or size cap is needed — expired entries are swept on every read.
 */

const DEFAULT_TTL_MS = 120_000; // 2 minutes

/** expiry epoch ms keyed by userId */
const _registry = new Map<string, number>();

/**
 * Record that userId's presence was just cleared. Any isRecentlyCleared() call
 * within ttlMs will return true, causing player-list nearbyPlayers writes to be
 * skipped so stale data can't re-arm name-overlap grouping.
 */
export function markRecentlyCleared(userId: string, ttlMs: number = DEFAULT_TTL_MS): void {
  _registry.set(userId, Date.now() + ttlMs);
}

/**
 * Remove the cleared-presence guard for userId immediately. Call when a
 * presence:update with a non-null endpoint arrives for the same user — they
 * joined a new world and the new world's player-list POSTs must not be blocked.
 */
export function clearRecentlyCleared(userId: string): void {
  _registry.delete(userId);
}

/**
 * Returns true if userId has an active cleared-presence guard (i.e. they left
 * a server recently and the TTL has not expired). Sweeps expired entries on every
 * call to keep the Map from growing without bound during long sessions.
 */
export function isRecentlyCleared(userId: string): boolean {
  const now = Date.now();
  // Sweep expired entries
  for (const [id, expiry] of _registry) {
    if (expiry <= now) _registry.delete(id);
  }
  const expiry = _registry.get(userId);
  return expiry !== undefined && expiry > now;
}

/**
 * Returns the number of seconds remaining in the cleared-presence guard for
 * userId, or 0 if no guard is active. Useful for log messages.
 */
export function secondsRemaining(userId: string): number {
  const expiry = _registry.get(userId);
  if (expiry === undefined) return 0;
  return Math.max(0, Math.round((expiry - Date.now()) / 1000));
}
