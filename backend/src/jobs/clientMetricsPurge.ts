/**
 * Daily purge of client_metrics rows older than 30 days.
 * Wired from server.ts via node-cron (runs at 03:17 UTC daily to spread load).
 */

import cron from 'node-cron';
import logger from '../config/logger';
import { purgeOldClientMetrics } from '../services/clientMetricsService';
import { makeJobTracker } from './jobTracker';

export function startClientMetricsPurgeJob(): void {
  const tracker = makeJobTracker('[clientMetricsPurge]');
  // 03:17 UTC daily. Return the tracker promise so node-cron overlap detection
  // works AND consecutive failures escalate warn → error (instead of the old
  // try/catch that swallowed every error as warn forever).
  cron.schedule('17 3 * * *', () =>
    tracker(async () => {
      const count = await purgeOldClientMetrics();
      logger.info({ count }, '[clientMetricsPurge] daily purge complete');
    }),
  );
  logger.info('[clientMetricsPurge] daily purge job scheduled (03:17 UTC)');
}
