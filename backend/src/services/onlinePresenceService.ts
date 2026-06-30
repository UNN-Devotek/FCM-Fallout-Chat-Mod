import { randomUUID } from 'crypto';
import { getRedisClient } from '../config/redis';
import logger from '../config/logger';

export const ONLINE_USERS_KEY_PREFIX = 'fcm:online:instance:';

const ONLINE_USERS_TTL_SEC = 45;
const INSTANCE_ID = randomUUID();
const INSTANCE_KEY = `${ONLINE_USERS_KEY_PREFIX}${INSTANCE_ID}`;

const openUserCounts = new Map<string, number>();
const pendingUsers = new Set<string>();

function decrementOpenCount(userId: string): number {
  const current = openUserCounts.get(userId) ?? 0;
  if (current <= 1) {
    openUserCounts.delete(userId);
    return 0;
  }
  const next = current - 1;
  openUserCounts.set(userId, next);
  return next;
}

function getLocalOnlineUserIds(): string[] {
  return Array.from(new Set<string>([
    ...openUserCounts.keys(),
    ...pendingUsers.values(),
  ]));
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

export function noteUserConnected(userId: string): void {
  openUserCounts.set(userId, (openUserCounts.get(userId) ?? 0) + 1);
  pendingUsers.delete(userId);
  void flushLocalPresenceToRedis();
}

export function noteUserPendingDisconnect(userId: string): boolean {
  const remaining = decrementOpenCount(userId);
  if (remaining === 0) {
    pendingUsers.add(userId);
    void flushLocalPresenceToRedis();
    return true;
  }
  void flushLocalPresenceToRedis();
  return false;
}

export function notePendingDisconnectSuppressed(userId: string): void {
  pendingUsers.delete(userId);
  void flushLocalPresenceToRedis();
}

export function noteUserDisconnected(userId: string): void {
  const remaining = decrementOpenCount(userId);
  if (remaining === 0) {
    pendingUsers.delete(userId);
  }
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
