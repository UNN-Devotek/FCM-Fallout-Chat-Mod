/**
 * serverChat.ts — ephemeral, worldId-scoped "server" chat room.
 *
 * Server chat is the in-game per-world room: players on the SAME Fallout 76
 * world (worldId) share a virtual channel `server:<worldId>`. It is deliberately
 * NOT persisted to Postgres — FO76 worlds churn constantly, so a per-world
 * `channels` row would be unbounded garbage. Instead:
 *   - recent history lives in a capped Redis list (auto-expiring), and
 *   - live delivery + cross-instance fan-out ride a dedicated Redis pub/sub channel.
 *
 * The relay handler owns routing/membership; this module owns storage + transport.
 */

import { getRedisClient } from '../../config/redis';
import logger from '../../config/logger';

/** Redis pub/sub channel carrying server-room events across backend instances. */
export const SERVER_EVENTS_CHANNEL = 'relay:server:events';

const HISTORY_PREFIX = 'relay:serverchat:';
const HISTORY_MAX = 50; // recent messages retained per world
const HISTORY_TTL_S = 3600; // room history auto-expires 1h after last activity (world churn)

const RL_PREFIX = 'relay:serverrl:';
const RL_MAX = 10; // messages per window per user
const RL_WINDOW_S = 10;

function historyKey(worldId: string): string {
  return `${HISTORY_PREFIX}${worldId}`;
}

/** A chat.message event as delivered to the ZFE client over the subscribe stream. */
export interface ServerRoomEvent {
  id: number; // relaySeq cursor
  kind: 'chat.message';
  messageId: string;
  channel: 'server';
  senderUserId: string;
  senderDisplayName: string;
  body: string;
  targetUserId: '';
  createdAt: string;
}

/** Envelope published on SERVER_EVENTS_CHANNEL. */
export type ServerEventEnvelope =
  | { kind: 'msg'; worldId: string; cursor: number; event: ServerRoomEvent }
  | { kind: 'rebind'; userId: string; worldId: string | null };

/**
 * Store a message in a world's capped history and fan it out live to same-world
 * subscribers (via the pub/sub channel). Ephemeral: the list is trimmed to
 * HISTORY_MAX and expires HISTORY_TTL_S after the last write.
 */
export async function publishServerMessage(
  worldId: string,
  cursor: number,
  event: ServerRoomEvent,
): Promise<void> {
  try {
    const redis = await getRedisClient();
    const key = historyKey(worldId);
    await redis.lPush(key, JSON.stringify(event));
    await redis.lTrim(key, 0, HISTORY_MAX - 1);
    await redis.expire(key, HISTORY_TTL_S);
    const envelope: ServerEventEnvelope = { kind: 'msg', worldId, cursor, event };
    await redis.publish(SERVER_EVENTS_CHANNEL, JSON.stringify(envelope));
  } catch (err) {
    logger.warn({ err, worldId }, '[serverChat] publishServerMessage failed');
  }
}

/**
 * Announce a subscriber's world-membership change so EVERY backend instance
 * re-binds that user's live subscriber(s) to the new world (or unbinds on leave).
 */
export async function publishRebind(userId: string, worldId: string | null): Promise<void> {
  try {
    const redis = await getRedisClient();
    const envelope: ServerEventEnvelope = { kind: 'rebind', userId, worldId };
    await redis.publish(SERVER_EVENTS_CHANNEL, JSON.stringify(envelope));
  } catch (err) {
    logger.warn({ err, userId }, '[serverChat] publishRebind failed');
  }
}

/**
 * Recent history for a world, oldest-first, only events newer than `sinceCursor`.
 * Used for world-join backfill and poll merge.
 */
export async function getServerHistory(
  worldId: string,
  sinceCursor: number,
  max: number,
): Promise<ServerRoomEvent[]> {
  try {
    const redis = await getRedisClient();
    const raw = await redis.lRange(historyKey(worldId), 0, HISTORY_MAX - 1); // newest-first
    const events: ServerRoomEvent[] = [];
    for (const s of raw) {
      try {
        events.push(JSON.parse(s) as ServerRoomEvent);
      } catch {
        /* skip corrupt entry */
      }
    }
    events.reverse(); // oldest-first
    return events.filter((e) => e.id > sinceCursor).slice(0, max);
  } catch (err) {
    logger.warn({ err, worldId }, '[serverChat] getServerHistory failed');
    return [];
  }
}

/**
 * Lightweight per-user flood guard for server sends (the ingestMessage rate
 * limiter is bypassed on this path). Fails OPEN on a Redis error — server chat
 * is ephemeral/low-stakes and automod still runs.
 */
export async function checkServerRateLimit(userId: string): Promise<boolean> {
  try {
    const redis = await getRedisClient();
    const key = `${RL_PREFIX}${userId}`;
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, RL_WINDOW_S);
    return n <= RL_MAX;
  } catch (err) {
    logger.warn({ err, userId }, '[serverChat] checkServerRateLimit failed — allowing');
    return true;
  }
}
