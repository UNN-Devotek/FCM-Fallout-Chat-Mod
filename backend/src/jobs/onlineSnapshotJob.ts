/**
 * Online-snapshot cron job.
 *
 * Inserts a row into online_snapshots every 5 minutes so the public stats
 * endpoint can serve an onlineOverTime chart (hourly buckets, last 24h).
 *
 * Also purges snapshots older than 7 days so the table stays small
 * (~2016 rows max steady state: 288 rows/day × 7 days).
 */

import cron from 'node-cron';
import logger from '../config/logger';
import { query as dbQuery } from '../config/database';
import { getClientCount } from '../websocket/handlers';

export function startOnlineSnapshotJob(): void {
  // Every 5 minutes — sample the current WS client count.
  // Overlap guard: node-cron does not await async callbacks, so a slow DB
  // write can still be in flight when the next tick fires. Skip rather than
  // queue duplicate inserts.
  let snapshotRunning = false;
  cron.schedule('*/5 * * * *', async () => {
    if (snapshotRunning) {
      logger.warn('[onlineSnapshot] previous insert still running — skipping this tick');
      return;
    }
    snapshotRunning = true;
    const onlineCount = getClientCount();
    try {
      await dbQuery(
        'INSERT INTO online_snapshots (online_count) VALUES ($1)',
        [onlineCount],
      );
    } catch (err) {
      logger.warn({ err, onlineCount }, '[onlineSnapshot] insert failed (non-fatal)');
    } finally {
      snapshotRunning = false;
    }
  });

  // Daily at 04:07 UTC — purge snapshots older than 7 days.
  let purgeRunning = false;
  cron.schedule('7 4 * * *', async () => {
    if (purgeRunning) {
      logger.warn('[onlineSnapshot] previous purge still running — skipping this tick');
      return;
    }
    purgeRunning = true;
    try {
      const result = await dbQuery(
        "DELETE FROM online_snapshots WHERE captured_at < now() - interval '7 days'",
        [],
      );
      logger.info({ count: result.rowCount }, '[onlineSnapshot] retention purge complete');
    } catch (err) {
      logger.warn({ err }, '[onlineSnapshot] retention purge failed (non-fatal)');
    } finally {
      purgeRunning = false;
    }
  });

  logger.info('[onlineSnapshot] snapshot job scheduled (*/5 * * * *); purge job at 04:07 UTC');
}
