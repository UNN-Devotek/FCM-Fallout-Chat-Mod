/**
 * campSyncSchedule — periodic full re-sync of the 76-CAMPDatabase.
 *
 * Enabled when CAMP_SYNC_INTERVAL_HOURS > 0.  Each tick calls runCampSync(),
 * which re-fetches the JSON, upserts all records, mirrors any new images, and
 * stores the content hash in Redis.
 *
 * A Redis lock key (fo76:camp:sync-lock) prevents overlapping runs when the
 * previous sync is still in progress.
 *
 * Default: disabled (CAMP_SYNC_INTERVAL_HOURS=0 or unset).
 */

import logger from '../config/logger';
import env from '../config/environment';
import { runCampSync } from '../services/campService';
import { getRedisClient } from '../config/redis';

const LOCK_KEY     = 'fo76:camp:sync-lock';
const LOCK_TTL_SEC = 60 * 60; // 1 hour — generous ceiling for a full sync

export function startCampSyncSchedule(): void {
  const hours = env.CAMP_SYNC_INTERVAL_HOURS;
  if (!hours || hours <= 0) {
    logger.info('[campSyncSchedule] disabled (CAMP_SYNC_INTERVAL_HOURS not set or 0)');
    return;
  }

  const intervalMs = hours * 60 * 60 * 1000;
  logger.info({ hours, intervalMs }, '[campSyncSchedule] sync scheduled');

  setInterval(async () => {
    logger.info('[campSyncSchedule] sync tick starting');

    // Distributed lock: skip if another sync is already in progress
    let redis;
    try {
      redis = await getRedisClient();
      const acquired = await redis.set(LOCK_KEY, '1', { NX: true, EX: LOCK_TTL_SEC });
      if (!acquired) {
        logger.info('[campSyncSchedule] lock held by another instance — skipping tick');
        return;
      }
    } catch (err) {
      logger.warn({ err }, '[campSyncSchedule] could not acquire lock — skipping tick');
      return;
    }

    try {
      const result = await runCampSync();
      logger.info(result, '[campSyncSchedule] sync tick complete');
    } catch (err) {
      logger.warn({ err }, '[campSyncSchedule] sync tick failed');
    } finally {
      try { await redis.del(LOCK_KEY); } catch { /* ignore */ }
    }
  }, intervalMs);
}
