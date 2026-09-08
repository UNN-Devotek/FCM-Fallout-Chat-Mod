import { randomUUID } from 'crypto';
import { getRedisClient } from '../config/redis';
import logger from '../config/logger';

export const ONLINE_USERS_KEY_PREFIX = 'fcm:online:instance:';

const ONLINE_USERS_TTL_SEC = 45;
const INSTANCE_ID = randomUUID();
const INSTANCE_KEY = `${ONLINE_USERS_KEY_PREFIX}${INSTANCE_ID}`;

// Read each transport's live registry rather than maintaining socket refcounts.
// Providers return linked FCM account IDs, so multiple devices/transports count once.
const localPresenceSources = new Map<string, () => string[]>();
let refreshTimer: ReturnType<typeof setInterval> | undefined;

// Legacy fallback sets — only consulted when no provider has been registered
// (e.g. unit tests that exercise the service in isolation). Kept minimal.
const fallbackUsers = new Set<string>();

/** Register a transport's authoritative local presence snapshot. Idempotent by name. */
export function registerLocalPresenceSource(provider: () => string[], source = 'websocket'): void {
  localPresenceSources.set(source, provider);
  // Keep quiet HUD-only instances visible to other instances beyond the Redis TTL.
  if (!refreshTimer) {
    refreshTimer = setInterval(() => { void flushLocalPresenceToRedis(); }, 15_000);
    refreshTimer.unref();
  }
}

export function getLocalOnlineUserIds(): string[] {
  if (localPresenceSources.size === 0) return Array.from(fallbackUsers);
  const users = new Set<string>();
  for (const provider of localPresenceSources.values()) {
    for (const userId of provider()) if (userId) users.add(userId);
  }
  return Array.from(users);
}

export async function flushLocalPresenceToRedis(): Promise<void> {
  try {
    const redis = await getRedisClient();
    const userIds = getLocalOnlineUserIds();
    const multi = redis.multi();
    multi.del(INSTANCE_KEY);
    if (userIds.length > 0) {
      multi.sAdd(INSTANCE_KEY, userIds);
      multi.expire(INSTANCE_KEY, ONLINE_USERS_TTL_SEC);
    }
    await multi.exec();
  } catch (err) {
    logger.warn({ err }, '[onlinePresenceService] failed to flush local online users');
  }
}

// The note*() calls are now pure "presence may have changed — flush soon"
// signals. The actual set is always recomputed from the live provider at flush
// time, so unbalanced calls can no longer corrupt the count. The fallback set
// is maintained only for the no-provider (unit-test) path.
export function noteUserConnected(userId: string): void {
  if (localPresenceSources.size === 0) fallbackUsers.add(userId);
  void flushLocalPresenceToRedis();
}

export function noteUserPendingDisconnect(_userId: string): boolean {
  void flushLocalPresenceToRedis();
  return true;
}

export function notePendingDisconnectSuppressed(_userId: string): void {
  void flushLocalPresenceToRedis();
}

export function noteUserDisconnected(userId: string): void {
  if (localPresenceSources.size === 0) fallbackUsers.delete(userId);
  void flushLocalPresenceToRedis();
}

export async function getGlobalOnlineCount(localFallback = 0): Promise<number> {
  await flushLocalPresenceToRedis();
  try {
    const redis = await getRedisClient();
    const keys: string[] = [];
    for await (const key of redis.scanIterator({ MATCH: `${ONLINE_USERS_KEY_PREFIX}*`, COUNT: 100 })) {
      if (typeof key === 'string') keys.push(key);
    }
    if (keys.length === 0) return 0;

    const users = new Set<string>();
    for (const key of keys) {
      const members = await redis.sMembers(key);
      for (const userId of members) users.add(userId);
    }
    return users.size;
  } catch (err) {
    logger.warn({ err }, '[onlinePresenceService] failed to aggregate global online count');
    return localFallback;
  }
}
