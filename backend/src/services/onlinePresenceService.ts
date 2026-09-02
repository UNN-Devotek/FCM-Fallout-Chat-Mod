import { randomUUID } from 'crypto';
import { getRedisClient } from '../config/redis';
import logger from '../config/logger';

export const ONLINE_USERS_KEY_PREFIX = 'fcm:online:instance:';

const ONLINE_USERS_TTL_SEC = 45;
const INSTANCE_ID = randomUUID();
const INSTANCE_KEY = `${ONLINE_USERS_KEY_PREFIX}${INSTANCE_ID}`;

// Single source of truth: the WS layer registers a provider that returns the
// userIds with at least one live (OPEN or flap-grace) socket on THIS instance.
// We deliberately do NOT maintain a parallel hand-incremented refcount here —
// that drifted whenever a note*() call was unbalanced (e.g. the golden-build
// reject path fired noteUserDisconnected without a matching noteUserConnected),
// inflating/corrupting the /online count. Reading the live socket registry
// directly makes that class of bug impossible.
let liveLocalUserIdsProvider: (() => string[]) | null = null;

// Legacy fallback sets — only consulted when no provider has been registered
// (e.g. unit tests that exercise the service in isolation). Kept minimal.
const fallbackUsers = new Set<string>();

/**
 * Register the authoritative source of locally-connected userIds. Called once
 * by the WS handlers module at load. Idempotent.
 */
export function registerLocalPresenceSource(provider: () => string[]): void {
  liveLocalUserIdsProvider = provider;
}

function getLocalOnlineUserIds(): string[] {
  if (liveLocalUserIdsProvider) {
    return Array.from(new Set<string>(liveLocalUserIdsProvider()));
  }
  return Array.from(fallbackUsers);
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
  if (!liveLocalUserIdsProvider) fallbackUsers.add(userId);
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
  if (!liveLocalUserIdsProvider) fallbackUsers.delete(userId);
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
