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

export interface RosterEntry {
  userId: string;
  name: string; // own character name (lowercased)
  seen: string[]; // observed nearby character names (lowercased)
}

export async function setRoster(relayUserId: string, ownName: string, seenNames: string[]): Promise<void> {
  try {
    const redis = await getRedisClient();
    const seen = [...new Set(seenNames.map((n) => n.trim().toLowerCase()).filter((n) => n.length > 0))].slice(0, MAX_NAMES);
    const value = JSON.stringify({ name: (ownName || '').trim().toLowerCase(), seen });
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
  const keys: string[] = await redis.keys(`${KEY_PREFIX}*`);
  const out: RosterEntry[] = [];
  for (const k of keys) {
    try {
      const raw = await redis.get(k);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      out.push({ userId: k.slice(KEY_PREFIX.length), name: parsed.name ?? '', seen: parsed.seen ?? [] });
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

/**
 * Cluster users into rooms by sighting edges (union-find) and return each user's
 * roomKey. A user with no edges gets a solo room keyed on their own userId —
 * server chat still works when alone on a world.
 */
export async function computeRooms(): Promise<Map<string, string>> {
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

  // Sighting edges: A saw B's character name, or B saw A's.
  for (const a of rosters) {
    for (const b of rosters) {
      if (a.userId >= b.userId) continue;
      const aSeesB = b.name.length > 0 && a.seen.includes(b.name);
      const bSeesA = a.name.length > 0 && b.seen.includes(a.name);
      if (aSeesB || bSeesA) union(a.userId, b.userId);
    }
  }

  const rooms = new Map<string, string>();
  for (const r of rosters) rooms.set(r.userId, `r:${find(r.userId)}`);
  return rooms;
}
