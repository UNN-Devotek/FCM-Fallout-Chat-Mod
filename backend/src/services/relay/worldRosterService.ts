/**
 * worldRosterService.ts — roster-derived world rooms.
 *
 * FO76's UI layer exposes NO unique world/server id (AccountInfoData.worldId never
 * existed — verified against the decompiled HUD). What the HUD DOES publish is the
 * nearby-player roster (TeamMarkers.Markers, VoiceChatAreaData.participants). The
 * widget reports the character names it observes; this service clusters connected
 * relay users into world rooms by SIGHTING edges: if A reports seeing B's character
 * name (or vice versa), A and B are on the same world.
 *
 * The computed roomKey feeds the EXISTING world-room machinery unchanged
 * (setWorldId / subscriber rebind / server:<key> ephemeral Redis room).
 *
 * Redis keys (TTL'd — a silent client falls out of its room):
 *   relay:roster:<relayUserId>  = JSON { name: <own fo76Name, lowercased>, seen: [names…] }
 */

import { getRedisClient } from '../../config/redis';
import logger from '../../config/logger';

const KEY_PREFIX = 'relay:roster:';
const TTL_SECONDS = 120;
const MAX_NAMES = 24;
const MAX_NAME_LENGTH = 64;
const MAX_ACTIVE_ROSTERS = 500;

export interface RosterEntry {
  userId: string;
  name: string; // own character name (lowercased)
  seen: string[]; // observed nearby character names (lowercased)
}

export async function setRoster(relayUserId: string, ownName: string, seenNames: string[]): Promise<void> {
  try {
    const redis = await getRedisClient();
    const seen = [...new Set(seenNames
      .map((n) => n.trim().toLowerCase())
      .filter((n) => n.length > 0 && n.length <= MAX_NAME_LENGTH))]
      .slice(0, MAX_NAMES);
    const name = (ownName || '').trim().toLowerCase().slice(0, MAX_NAME_LENGTH);
    const value = JSON.stringify({ name, seen });
    await redis.set(`${KEY_PREFIX}${relayUserId}`, value, { EX: TTL_SECONDS });
  } catch (err) {
    logger.warn({ err, relayUserId }, '[worldRoster] setRoster failed');
  }
}

export async function clearRoster(relayUserId: string): Promise<void> {
  try {
    const redis = await getRedisClient();
    await redis.del(`${KEY_PREFIX}${relayUserId}`);
  } catch (err) {
    logger.warn({ err, relayUserId }, '[worldRoster] clearRoster failed');
  }
}

/** All live rosters (TTL-pruned by Redis). */
async function getAllRosters(): Promise<RosterEntry[]> {
  const redis = await getRedisClient();
  const keys: string[] = [];
  for await (const scanResult of redis.scanIterator({ MATCH: `${KEY_PREFIX}*`, COUNT: 100 })) {
    for (const key of scanKeys(scanResult)) {
      if (keys.length >= MAX_ACTIVE_ROSTERS) {
        logger.warn({ maxActiveRosters: MAX_ACTIVE_ROSTERS }, '[worldRoster] roster scan capped');
        break;
      }
      keys.push(key);
    }
    if (keys.length >= MAX_ACTIVE_ROSTERS) break;
  }

  const entries = await Promise.all(keys.map(async (key): Promise<RosterEntry | null> => {
    try {
      const raw = await redis.get(key);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!isRosterPayload(parsed)) return null;
      return { userId: key.slice(KEY_PREFIX.length), name: parsed.name, seen: parsed.seen };
    } catch {
      return null;
    }
  }));
  return entries.filter((entry): entry is RosterEntry => entry !== null);
}

function scanKeys(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  return [];
}

function isRosterPayload(value: unknown): value is { name: string; seen: string[] } {
  if (!value || typeof value !== 'object' || !('name' in value) || !('seen' in value)) return false;
  return typeof value.name === 'string'
    && Array.isArray(value.seen)
    && value.seen.every((name) => typeof name === 'string');
}

/**
 * Cluster users into rooms by sighting edges (union-find) and return each user's
 * roomKey. A user with no edges gets a solo room keyed on their own userId —
 * server chat still works when alone on a world.
 */
export async function computeRooms(): Promise<Map<string, string>> {
  const startedAt = Date.now();
  const rosters = await getAllRosters();
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; }
    return r;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  for (const r of rosters) parent.set(r.userId, r.userId);

  // Require mutual sightings. A single client can lie about its outgoing
  // roster, so one-sided edges are not enough to merge two private rooms.
  // Index owners by character name to keep this O(N * MAX_NAMES) instead of
  // comparing every roster pair.
  const byName = new Map<string, RosterEntry[]>();
  for (const roster of rosters) {
    if (!roster.name) continue;
    const owners = byName.get(roster.name) ?? [];
    owners.push(roster);
    byName.set(roster.name, owners);
  }
  for (const a of rosters) {
    for (const seenName of a.seen) {
      for (const b of byName.get(seenName) ?? []) {
        if (a.userId === b.userId || !b.seen.includes(a.name)) continue;
        union(a.userId, b.userId);
      }
    }
  }

  const rooms = new Map<string, string>();
  for (const r of rosters) rooms.set(r.userId, `r:${find(r.userId)}`);
  logger.debug({ rosterCount: rosters.length, elapsedMs: Date.now() - startedAt }, '[worldRoster] rooms recomputed');
  return rooms;
}
