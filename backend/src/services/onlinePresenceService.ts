import { randomUUID } from 'crypto';
import { getRedisClient } from '../config/redis';
import logger from '../config/logger';
import prisma from '../config/prisma';
import { runtime, producerInterval } from '../runtime';

export const ONLINE_USERS_KEY_PREFIX = 'fcm:online:instance:';
export const DISCORD_ACTIVITY_KEY = 'fcm:online:discord-active';
export const DISCORD_ACTIVITY_MS = 15 * 60_000;
const COUNT_FAILURE_GRACE_MS = 90_000;
let lastGoodCount: { count: number; at: number } | undefined;
let countPending: Promise<number> | undefined;

async function presenceRedis() {
  const redis = await getRedisClient();
  if (!redis.isReady) throw new Error('Presence storage unavailable');
  return redis.withCommandOptions({ timeout: 5_000 });
}

/** Only trusted Discord gateway messages from mapped channels call this. Discord
 * IDs survive account linking/merges; resolve to current account IDs when counting. */
export async function noteDiscordMessageActivity(discordId: string): Promise<void> {
  if (!/^[0-9]{15,22}$/.test(discordId)) return;
  try {
    const redis = await presenceRedis();
    const now = Date.now();
    await redis.multi()
      .zRemRangeByScore(DISCORD_ACTIVITY_KEY, '-inf', now)
      .zAdd(DISCORD_ACTIVITY_KEY, { score: now + DISCORD_ACTIVITY_MS, value: discordId }, { GT: true })
      .expire(DISCORD_ACTIVITY_KEY, DISCORD_ACTIVITY_MS / 1000)
      .exec();
  } catch (err) {
    logger.warn({ err }, '[onlinePresenceService] Discord activity write failed');
  }
}

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
    refreshTimer = producerInterval('presence-flush', () => flushLocalPresenceToRedis(), 15_000);
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
    const redis = await presenceRedis();
    const userIds = getLocalOnlineUserIds();
    const multi = redis.multi();
    multi.del(INSTANCE_KEY);
    if (userIds.length > 0) {
      multi.sAdd(INSTANCE_KEY, userIds);
      multi.expire(INSTANCE_KEY, ONLINE_USERS_TTL_SEC);
    }
    await multi.exec();
  } catch (err) {
    runtime.recordFailure('presence-flush', err);
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

async function readGlobalOnlineCount(): Promise<number> {
  await flushLocalPresenceToRedis();
  try {
    const redis = await presenceRedis();
    const keys = new Set<string>();
    for await (const batch of redis.scanIterator({ MATCH: `${ONLINE_USERS_KEY_PREFIX}*`, COUNT: 100 })) {
      // node-redis 5/6 yields arrays; retain compatibility with older adapters.
      for (const key of Array.isArray(batch) ? batch : [batch]) if (typeof key === 'string') keys.add(key);
    }
    const users = new Set(getLocalOnlineUserIds());
    for (const key of keys) {
      const members = await redis.sMembers(key);
      for (const userId of members) users.add(userId);
    }
    const now = Date.now();
    await redis.zRemRangeByScore(DISCORD_ACTIVITY_KEY, '-inf', now);
    const discordIds = await redis.zRangeByScore(DISCORD_ACTIVITY_KEY, `(${now}`, '+inf');
    // Bounded SQL batches; identities are never returned in public stats.
    for (let offset = 0; offset < discordIds.length; offset += 500) {
      const batch = discordIds.slice(offset, offset + 500);
      const accounts = await prisma.user.findMany({ where: { discordId: { in: batch } }, select: { id: true, discordId: true } });
      const byDiscord = new Map(accounts.map(account => [account.discordId, account.id]));
      for (const id of batch) users.add(byDiscord.get(id) ?? `discord:${id}`);
    }
    lastGoodCount = { count: users.size, at: Date.now() };
    return users.size;
  } catch (err) {
    logger.warn({ err }, '[onlinePresenceService] failed to aggregate global online count');
    // A failed read is not a zero or a process-local total. Keep a bounded last
    // good value, then report unavailable to callers instead of inventing a count.
    if (lastGoodCount && Date.now() - lastGoodCount.at < COUNT_FAILURE_GRACE_MS) return lastGoodCount.count;
    throw err;
  }
}

export function getGlobalOnlineCount(_legacyLocalFallback = 0): Promise<number> {
  // Share simultaneous reads so bot/site/overlay requests do not duplicate work.
  if (!countPending) countPending = readGlobalOnlineCount().finally(() => { countPending = undefined; });
  return countPending;
}
