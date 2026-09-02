import { getRedisClient } from '../config/redis';
import logger from '../config/logger';

// Real player list per server endpoint, sourced from the FO76 BA2 companion mod.
// TTL: 90 seconds — if the mod stops writing (game closed, mod missing), the key
// expires and [Server Count] / [Server Users] fall back to counting chat-mod users
// on the same endpoint (the original behavior).

const PLAYER_LIST_TTL_SEC = 90;
const REDIS_KEY_PREFIX = 'fo76:players:';
const USER_KEY_PREFIX = 'fo76:players:user:';

// Validation limits — player names come from an uncontrolled Flash mod.
// FO76 worlds hold 24 players; cap the stored list at 24 so welcome and
// /sc never show "30/24" even when the scanner surfaces stale / cached /
// camp-owner names beyond the live world roster.
const MAX_PLAYERS = 24;
const MAX_NAME_LEN = 64;
const SAFE_NAME_RE = /^[\x20-\x7E\u00C0-\u024F]+$/; // printable ASCII + Latin Extended

export interface ServerPlayerList {
  endpoint: string;
  players: string[];
  updatedAt: number; // unix ms
}

export function validatePlayerList(endpoint: string, players: unknown[]): string[] {
  return players
    .slice(0, MAX_PLAYERS)
    .map(n => (typeof n === 'string' ? n.trim() : ''))
    .filter(n => n.length > 0 && n.length <= MAX_NAME_LEN && SAFE_NAME_RE.test(n));
}

export async function setServerPlayers(endpoint: string, players: string[]): Promise<void> {
  try {
    const redis = await getRedisClient();
    const value = JSON.stringify({ endpoint, players, updatedAt: Date.now() });
    await redis.set(`${REDIS_KEY_PREFIX}${endpoint}`, value, { EX: PLAYER_LIST_TTL_SEC });
  } catch (err) {
    logger.warn({ err, endpoint }, 'Failed to store server player list in Redis');
  }
}

export async function getServerPlayers(endpoint: string): Promise<ServerPlayerList | null> {
  try {
    const redis = await getRedisClient();
    const raw = await redis.get(`${REDIS_KEY_PREFIX}${endpoint}`);
    if (!raw) return null;
    return JSON.parse(raw) as ServerPlayerList;
  } catch {
    return null;
  }
}

export async function setServerPlayersForUser(userId: string, players: string[], endpoint: string | null): Promise<void> {
  try {
    const redis = await getRedisClient();
    const value = JSON.stringify({ endpoint: endpoint ?? `user:${userId}`, players, updatedAt: Date.now() });
    await redis.set(`${USER_KEY_PREFIX}${userId}`, value, { EX: PLAYER_LIST_TTL_SEC });
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to store user player list in Redis');
  }
}

export async function getServerPlayersForUser(userId: string): Promise<ServerPlayerList | null> {
  try {
    const redis = await getRedisClient();
    const raw = await redis.get(`${USER_KEY_PREFIX}${userId}`);
    if (!raw) return null;
    return JSON.parse(raw) as ServerPlayerList;
  } catch {
    return null;
  }
}

// Session-keyed cache. The same player-list snapshot is mirrored under a
// sessionId key so [Server Count] / [Server Users] can be resolved for users
// who have a worldSessionId but no `serverEndpoint` string.
const SESSION_KEY_PREFIX = 'fo76:players:session:';

export async function setServerPlayersForSession(sessionId: string, players: string[], endpoint: string | null): Promise<void> {
  try {
    const redis = await getRedisClient();
    const value = JSON.stringify({ endpoint: endpoint ?? `session:${sessionId}`, players, updatedAt: Date.now() });
    await redis.set(`${SESSION_KEY_PREFIX}${sessionId}`, value, { EX: PLAYER_LIST_TTL_SEC });
  } catch (err) {
    logger.warn({ err, sessionId }, 'Failed to store session player list in Redis');
  }
}

export async function getServerPlayersForSession(sessionId: string): Promise<ServerPlayerList | null> {
  try {
    const redis = await getRedisClient();
    const raw = await redis.get(`${SESSION_KEY_PREFIX}${sessionId}`);
    if (!raw) return null;
    return JSON.parse(raw) as ServerPlayerList;
  } catch {
    return null;
  }
}

// Evict caches after server:leave-manual so /sc does not accidentally resolve
// to a stale count on a Refresh-and-rejoin. The next player-list POST repopulates.
export async function clearServerPlayersForSession(sessionId: string): Promise<void> {
  try {
    const redis = await getRedisClient();
    await redis.del(`${SESSION_KEY_PREFIX}${sessionId}`);
  } catch (err) {
    logger.warn({ err, sessionId }, 'Failed to clear session player list in Redis');
  }
}

export async function clearServerPlayers(endpoint: string): Promise<void> {
  try {
    const redis = await getRedisClient();
    await redis.del(`${REDIS_KEY_PREFIX}${endpoint}`);
  } catch (err) {
    logger.warn({ err, endpoint }, 'Failed to clear server player list in Redis');
  }
}
