/**
 * worldIdService.ts — per-relay-user worldId store backed by Redis.
 *
 * Redis key: relay:world:<relayUserId>  TTL: 60 seconds
 *
 * ZFE clients send their worldId on each SEND frame; the relay handler calls
 * setWorldId() to refresh the TTL, and looks it up via getWorldId() when
 * routing to the dynamic 'server' channel.
 */

import { getRedisClient } from '../../config/redis';
import logger from '../../config/logger';

const KEY_PREFIX = 'relay:world:';
const TTL_SECONDS = 60;

function worldKey(relayUserId: string): string {
  return `${KEY_PREFIX}${relayUserId}`;
}

/**
 * Store (or refresh) the worldId for a relay user.
 * TTL is reset to 60 s on every call, so clients that are actively sending
 * messages never expire.
 */
export async function setWorldId(relayUserId: string, worldId: string): Promise<void> {
  try {
    const redis = await getRedisClient();
    await redis.set(worldKey(relayUserId), worldId, { EX: TTL_SECONDS });
  } catch (err) {
    logger.warn({ err, relayUserId }, '[worldIdService] setWorldId failed');
  }
}

/**
 * Retrieve the current worldId for a relay user.
 * Returns null when the key is missing or expired.
 */
export async function getWorldId(relayUserId: string): Promise<string | null> {
  try {
    const redis = await getRedisClient();
    return await redis.get(worldKey(relayUserId));
  } catch (err) {
    logger.warn({ err, relayUserId }, '[worldIdService] getWorldId failed');
    return null;
  }
}

/**
 * Explicitly delete the worldId for a relay user (e.g. on disconnect or LEAVE).
 */
export async function clearWorldId(relayUserId: string): Promise<void> {
  try {
    const redis = await getRedisClient();
    await redis.del(worldKey(relayUserId));
  } catch (err) {
    logger.warn({ err, relayUserId }, '[worldIdService] clearWorldId failed');
  }
}
