/**
 * Name blacklist.
 *
 * Rejects username candidates that match patterns in the `name_blacklist`
 * table. The memory-reader service can latch onto random heap strings (FO76
 * item names, menu labels, banner text) when the character-name region
 * shifts; without this, those bad reads land directly on `users.username`
 * and become the user's displayed name in chat.
 *
 * Cache: full table loaded into memory on boot and on every admin write.
 * The cache is refreshed via:
 *   - explicit `refreshBlacklist()` (called from the admin controller after
 *     create / update / delete);
 *   - Redis pub/sub `name-blacklist:updated` (so multi-instance deployments
 *     stay in sync — single-instance deployment treats it as a no-op).
 *
 * Match types:
 *   - "exact"    — case-insensitive equality after trim
 *   - "contains" — case-insensitive substring
 *   - "regex"    — JS regex compiled with `i` flag; invalid regex → entry skipped
 */

import prisma from '../config/prisma';
import logger from '../config/logger';
import { getRedisClient } from '../config/redis';
import { compileUserRegex } from '../utils/safeRegex';

interface BlacklistEntry {
  id: string;
  pattern: string;
  matchType: 'exact' | 'contains' | 'regex';
  enabled: boolean;
  /** Pre-compiled regex for `matchType === 'regex'` entries; null if invalid. */
  regex: RegExp | null;
}

let cache: BlacklistEntry[] = [];
let loaded = false;

const PUBSUB_CHANNEL = 'name-blacklist:updated';

export async function loadBlacklist(): Promise<void> {
  try {
    const rows = await prisma.nameBlacklistEntry.findMany({
      where: { enabled: true },
      select: { id: true, pattern: true, matchType: true, enabled: true },
    });
    cache = rows.map(r => ({
      id: r.id,
      pattern: r.pattern,
      matchType: (r.matchType as 'exact' | 'contains' | 'regex'),
      enabled: r.enabled,
      regex: r.matchType === 'regex' ? tryCompile(r.pattern) : null,
    }));
    loaded = true;
    logger.info({ count: cache.length }, '[nameBlacklist] cache loaded');
  } catch (err) {
    logger.warn({ err }, '[nameBlacklist] failed to load cache — predicate will return false until next retry');
  }
}

function tryCompile(pattern: string): RegExp | null {
  return compileUserRegex(pattern, 'nameBlacklist');
}

/**
 * Returns true if `name` matches any enabled blacklist entry. False on
 * empty/non-string input. Safe to call before `loadBlacklist()` resolves
 * (returns false until cache is populated).
 */
export function isBlacklisted(name: string | null | undefined): boolean {
  if (!loaded || cache.length === 0) return false;
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  const lower = trimmed.toLowerCase();
  for (const entry of cache) {
    if (!entry.enabled) continue;
    if (entry.matchType === 'exact') {
      if (lower === entry.pattern.toLowerCase()) return true;
    } else if (entry.matchType === 'contains') {
      if (lower.includes(entry.pattern.toLowerCase())) return true;
    } else if (entry.matchType === 'regex' && entry.regex) {
      if (entry.regex.test(trimmed)) return true;
    }
  }
  return false;
}

/**
 * Diagnostic variant — returns the matching entry so callers can log
 * which pattern fired. Same predicate as `isBlacklisted`.
 */
export function findBlacklistMatch(name: string | null | undefined): BlacklistEntry | null {
  if (!loaded || cache.length === 0) return null;
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  const lower = trimmed.toLowerCase();
  for (const entry of cache) {
    if (!entry.enabled) continue;
    if (entry.matchType === 'exact') {
      if (lower === entry.pattern.toLowerCase()) return entry;
    } else if (entry.matchType === 'contains') {
      if (lower.includes(entry.pattern.toLowerCase())) return entry;
    } else if (entry.matchType === 'regex' && entry.regex) {
      if (entry.regex.test(trimmed)) return entry;
    }
  }
  return null;
}

/**
 * Reload cache from the DB. Call after any admin write to keep this
 * process's predicate up-to-date. Also publishes to Redis pub/sub so
 * other instances refresh.
 */
export async function refreshBlacklist(): Promise<void> {
  await loadBlacklist();
  try {
    const redis = await getRedisClient();
    await redis.publish(PUBSUB_CHANNEL, JSON.stringify({ ts: Date.now() }));
  } catch (err) {
    logger.debug({ err }, '[nameBlacklist] Redis publish failed (non-fatal)');
  }
}

/**
 * Subscribe to cross-instance refresh broadcasts. Called once at server
 * startup. The subscriber refreshes the local cache when ANY instance
 * publishes a name-blacklist:updated event.
 */
export async function subscribeBlacklistUpdates(): Promise<void> {
  try {
    const redis = await getRedisClient();
    const sub = redis.duplicate();
    await sub.connect();
    await sub.subscribe(PUBSUB_CHANNEL, async () => {
      logger.info('[nameBlacklist] received cross-instance refresh signal');
      await loadBlacklist();
    });
    logger.info('[nameBlacklist] subscribed to refresh channel');
  } catch (err) {
    logger.warn({ err }, '[nameBlacklist] failed to subscribe to refresh channel');
  }
}

export function getCacheSize(): number {
  return cache.length;
}
