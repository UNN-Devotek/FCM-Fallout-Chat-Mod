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
import { makeJobTracker } from './jobTracker';

export function startOnlineSnapshotJob(): void {
  const snapshotTracker = makeJobTracker('[onlineSnapshot]');
  const purgeTracker = makeJobTracker('[onlineSnapshot:purge]');

  // Every 5 minutes — sample the current WS client count.
  // Return the tracker promise so node-cron's overlap detection sees the tick
  // as in-flight (it skips a new fire while the returned promise is pending)
  // AND the tracker observes any failure for consecutive-failure escalation.
  cron.schedule('*/5 * * * *', () => {
    const onlineCount = getClientCount();
    return snapshotTracker(async () => {
      await dbQuery(
        'INSERT INTO online_snapshots (online_count) VALUES ($1)',
        [onlineCount],
      );
    });
  });

  // Daily at 04:07 UTC — purge snapshots older than 7 days.
  cron.schedule('7 4 * * *', () =>
    purgeTracker(async () => {
      const result = await dbQuery(
        "DELETE FROM online_snapshots WHERE captured_at < now() - interval '7 days'",
        [],
      );
      logger.info({ count: result.rowCount }, '[onlineSnapshot] retention purge complete');
    }),
  );

  logger.info('[onlineSnapshot] snapshot job scheduled (*/5 * * * *); purge job at 04:07 UTC');
}
