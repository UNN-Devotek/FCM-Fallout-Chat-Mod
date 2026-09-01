/**
 * Durable bridge for the relay client-capability handshake.
 *
 * ZFE may use separate WebSocket connections for connect/register and the
 * long-lived subscribe stream. The pure clientCapability module keeps a local
 * fast-path registry, but that registry is not visible after a backend restart
 * or on another backend instance. Redis carries only the token digest and the
 * reported version so the HUD cosmetic fields are not accidentally stripped.
 */

import { createHash } from 'node:crypto';
import { getRedisClient } from '../../config/redis';
import logger from '../../config/logger';
import {
  rememberTokenClientVersion,
  supportsCosmetics,
  supportsHudCosmeticsTransport,
  tokenSupportsCosmetics,
  tokenSupportsHudCosmeticsTransport,
} from './clientCapability';

const KEY_PREFIX = 'relay:client-capability:';
const TTL_SECONDS = 24 * 60 * 60;

type CapabilityRedis = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
};

type RedisFactory = () => Promise<CapabilityRedis>;

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Exported for tests and operational diagnostics; never contains the bearer token. */
export function tokenCapabilityKey(token: string): string {
  return `${KEY_PREFIX}${tokenDigest(token)}`;
}

/**
 * Remember a client version locally and in Redis. Redis failure is non-fatal:
 * the current process can still serve its own connect/subscribe pair from the
 * local registry, while a later read fails closed until Redis is available.
 */
export async function rememberTokenClientVersionDurable(
  token: unknown,
  raw: unknown,
  redisFactory: RedisFactory = getRedisClient,
): Promise<void> {
  rememberTokenClientVersion(token, raw);
  if (typeof token !== 'string' || !token || typeof raw !== 'string' || !raw.trim()) return;

  try {
    const redis = await redisFactory();
    await redis.set(tokenCapabilityKey(token), raw.trim(), { EX: TTL_SECONDS });
  } catch (err) {
    logger.warn({ err }, '[relay] durable client-capability write failed');
  }
}

/**
 * Resolve capability from the local registry first, then Redis. A missing,
 * malformed, or unavailable record remains fail-closed for old widgets.
 */
export async function tokenSupportsCosmeticsDurable(
  token: unknown,
  redisFactory: RedisFactory = getRedisClient,
): Promise<boolean> {
  if (typeof token !== 'string' || !token) return false;
  if (tokenSupportsCosmetics(token)) return true;

  try {
    const redis = await redisFactory();
    const raw = await redis.get(tokenCapabilityKey(token));
    if (typeof raw !== 'string' || !raw.trim()) return false;

    // Warm the local fast path for subsequent polls/live operations.
    rememberTokenClientVersion(token, raw);
    return supportsCosmetics(raw);
  } catch (err) {
    logger.warn({ err }, '[relay] durable client-capability read failed');
    return false;
  }
}

/** Resolve the stricter native-known-field transport capability. */
export async function tokenSupportsHudCosmeticsTransportDurable(
  token: unknown,
  redisFactory: RedisFactory = getRedisClient,
): Promise<boolean> {
  if (typeof token !== 'string' || !token) return false;
  if (tokenSupportsHudCosmeticsTransport(token)) return true;

  try {
    const redis = await redisFactory();
    const raw = await redis.get(tokenCapabilityKey(token));
    if (typeof raw !== 'string' || !raw.trim()) return false;

    rememberTokenClientVersion(token, raw);
    return supportsHudCosmeticsTransport(raw);
  } catch (err) {
    logger.warn({ err }, '[relay] durable HUD transport-capability read failed');
    return false;
  }
}

export default {
  tokenCapabilityKey,
  rememberTokenClientVersionDurable,
  tokenSupportsCosmeticsDurable,
  tokenSupportsHudCosmeticsTransportDurable,
};
