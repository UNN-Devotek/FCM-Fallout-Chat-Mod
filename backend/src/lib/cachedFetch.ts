/**
 * cachedFetch — shared Redis cache-aside helper used by nukeCodesService
 * and serverStatusService.
 *
 * Pattern: try Redis GET → return parsed value; on miss call `fetcher()`,
 * store result with TTL, return it.  On any Redis error falls back to
 * calling `fetcher()` directly (best-effort caching).
 */

import { getRedisClient } from '../config/redis';
import logger from '../config/logger';

/**
 * Cache-aside fetch. Returns null only when both the cache and the fetcher fail.
 *
 * @param key     Redis key
 * @param ttlSec  Cache TTL in seconds
 * @param fetcher Async function that produces the fresh value (or null on failure)
 */
export async function cachedFetch<T>(
  key:     string,
  ttlSec:  number,
  fetcher: () => Promise<T | null>,
): Promise<T | null> {
  // 1. Try cache
  try {
    const redis  = await getRedisClient();
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached) as T;
  } catch (err) {
    logger.warn({ err, key }, '[cachedFetch] Redis read failed, falling back to live fetch');
  }

  // 2. Live fetch
  const fresh = await fetcher();
  if (!fresh) return null;

  // 3. Write back to cache (best-effort)
  try {
    const redis = await getRedisClient();
    await redis.set(key, JSON.stringify(fresh), { EX: ttlSec });
  } catch (err) {
    logger.warn({ err, key }, '[cachedFetch] Redis write failed (non-fatal)');
  }

  return fresh;
}
