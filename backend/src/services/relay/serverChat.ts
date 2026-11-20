import { runRequiredBundle, runRequiredLookup, runRequiredMutation } from '../../lib/requiredEffects';
/**
 * serverChat.ts — ephemeral, worldId-scoped "server" chat room.
 *
 * Server chat is the native relay's virtual channel `server:<worldId>`. Modern
 * worldId values are ephemeral room keys inferred from mutual HUD roster sightings,
 * not authoritative Fallout world identifiers. It is deliberately
 * NOT persisted to Postgres — FO76 worlds churn constantly, so a per-world
 * `channels` row would be unbounded garbage. Instead:
 *   - recent history lives in a capped Redis list (auto-expiring), and
 *   - live delivery + cross-instance fan-out ride a dedicated Redis pub/sub channel.
 *
 * The relay handler owns routing/membership; this module owns storage + transport.
 */

import { getRedisClient } from '../../config/redis';
import logger from '../../config/logger';
import { noteModerationRoom } from './serverModeration';

/** Redis pub/sub channel carrying server-room events across backend instances. */
export const SERVER_EVENTS_CHANNEL = 'relay:server:events';
/** In-process provenance only: JSON/socket payloads cannot supply this marker. */
export const SERVER_HISTORY_ROOM = Symbol('serverHistoryRoom');

const HISTORY_PREFIX = 'relay:serverchat:';
const HISTORY_MAX = 50; // recent messages retained per world
const HISTORY_TTL_S = 3600; // room history auto-expires 1h after last activity (world churn)

const RL_PREFIX = 'relay:serverrl:';
const RL_MAX = 10; // messages per window per user
const RL_WINDOW_S = 10;

function historyKey(worldId: string): string {
  return `${HISTORY_PREFIX}${worldId}`;
}

/** Seed a newly isolated room with already-authorized history. COPY is atomic,
 * preserves the source TTL and never replaces a destination or publishes events.
 * Only the room coordinator may select source/destination; clients cannot do so. */
export async function copySplitRoomHistory(source: string, destination: string): Promise<void> {
  if (source === destination) throw new Error('Split history requires a new room');
  const redis = await getRedisClient();
  await runRequiredMutation('publication', 'a1d48bf10c9d09cb4e24849c',
    { stage: 'split-room-history-copy-unconfirmed' }, () => redis.copy(historyKey(source), historyKey(destination)),
    undefined, undefined, reply => reply === 0);
  await noteModerationRoom(destination).catch(() => {});
}

/** A chat.message event as delivered to the ZFE client over the subscribe stream. */
export interface ServerRoomEvent {
  [SERVER_HISTORY_ROOM]?: string;
  id: number; // relaySeq cursor
  kind: 'chat.message';
  messageId: string;
  channel: 'server';
  senderUserId: string;
  /** Account at send time, for private desktop delivery/block filtering. */
  linkedUserId?: string;
  senderDisplayName: string;
  body: string;
  targetUserId: '';
  createdAt: string;
  /** Additive fields understood by widget builds with HUD cosmetics support. */
  tag?: string;
  nameColor?: string;
  supporterStar?: true;
  starColor?: string;
}

/** Envelope published on SERVER_EVENTS_CHANNEL. */
export type ServerEventEnvelope =
  | { kind: 'msg'; worldId: string; cursor: number; event: ServerRoomEvent }
  | { kind: 'rebind'; userId: string; worldId: string | null; requestId?: string; sourceInstanceId?: string }
  | { kind: 'history-resync'; userId: string; sourceInstanceId: string };

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
  return runRequiredBundle('publication', 'serverChat:7b57b2539bea', async () => {
  try {
    const redis = await getRedisClient();
    const key = historyKey(worldId);
    await runRequiredMutation('publication', '0642ce00332769f66de96fa3', { stage: 'primary-write-unconfirmed' }, () => redis.lPush(key, JSON.stringify(event)), undefined, undefined, undefined);
    await runRequiredMutation('publication', 'e9bbaecdbd1e755640c51244', { stage: 'primary-write-unconfirmed' }, () => redis.lTrim(key, 0, HISTORY_MAX - 1), undefined, undefined, undefined);
    await runRequiredMutation('publication', 'c528fcea23ab44bc3138047d', { stage: 'primary-write-unconfirmed' }, () => redis.expire(key, HISTORY_TTL_S), undefined, undefined, undefined);
    // Indexing is independent from delivery: failure must not suppress normal chat.
    await noteModerationRoom(worldId).catch(err => {
      logger.warn({ err }, '[serverChat] moderation index unavailable');
    });
    const envelope: ServerEventEnvelope = { kind: 'msg', worldId, cursor, event };
    await runRequiredMutation('publication', '7b8ecd24d26b2052059d282b', { stage: 'primary-write-unconfirmed' }, () => redis.publish(SERVER_EVENTS_CHANNEL, JSON.stringify(envelope)), undefined, undefined, undefined);
  } catch (err) {
    logger.warn({ err, worldId }, '[serverChat] publishServerMessage failed');
    throw err;
  }

  });
}

/**
 * Announce a subscriber's world-membership change so EVERY backend instance
 * re-binds that user's live subscriber(s) to the new world (or unbinds on leave).
 */
export async function publishRebind(userId: string, worldId: string | null, requestId?: string, sourceInstanceId?: string): Promise<void> {
  return runRequiredBundle('publication', 'serverChat:bc894a0e334e', async () => {
  try {
    const redis = await runRequiredLookup('publication', 'server-rebind:publication-client', () => getRedisClient(), 'required');
    const envelope: ServerEventEnvelope = { kind: 'rebind', userId, worldId, requestId, sourceInstanceId };
    await runRequiredMutation('publication', '005bd0701988c5bbcb80e563', { stage: 'primary-write-unconfirmed' }, () => redis.publish(SERVER_EVENTS_CHANNEL, JSON.stringify(envelope)), undefined, undefined, undefined);
  } catch (err) {
    logger.warn({ err, userId }, '[serverChat] publishRebind failed');
  }

  });
}

/**
 * Ask every backend instance to replay static history to this user's local live
 * subscriber(s). The HUD can reload while ZFE keeps its native subscription alive,
 * so a fresh subscribe-time backfill is not guaranteed on a world transition.
 */
export async function publishHistoryResync(userId: string, sourceInstanceId: string): Promise<void> {
  return runRequiredBundle('publication', 'serverChat:8be251f94d6b', async () => {
  try {
    const redis = await runRequiredLookup('publication', 'history-resync:publication-client', () => getRedisClient(), 'required');
    const envelope: ServerEventEnvelope = { kind: 'history-resync', userId, sourceInstanceId };
    await runRequiredMutation('publication', '0773abed79c09e9498150bab', { stage: 'primary-write-unconfirmed' }, () => redis.publish(SERVER_EVENTS_CHANNEL, JSON.stringify(envelope)), undefined, undefined, undefined);
  } catch (err) {
    logger.warn({ err, userId }, '[serverChat] publishHistoryResync failed');
  }

  });
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
        const event = JSON.parse(s) as ServerRoomEvent;
        event[SERVER_HISTORY_ROOM] = worldId;
        events.push(event);
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
