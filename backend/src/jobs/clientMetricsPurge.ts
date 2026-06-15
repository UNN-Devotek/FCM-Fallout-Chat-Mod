/**
 * Daily purge of client_metrics rows older than 30 days.
 * Wired from server.ts via node-cron (runs at 03:17 UTC daily to spread load).
 */

import cron from 'node-cron';
import logger from '../config/logger';
import { purgeOldClientMetrics } from '../services/clientMetricsService';

export function startClientMetricsPurgeJob(): void {
  // 03:17 UTC daily
  cron.schedule('17 3 * * *', async () => {
    try {
      const count = await purgeOldClientMetrics();
      logger.info({ count }, '[clientMetricsPurge] daily purge complete');
    } catch (err) {
      logger.warn({ err }, '[clientMetricsPurge] daily purge error (non-fatal)');
    }
  });
  logger.info('[clientMetricsPurge] daily purge job scheduled (03:17 UTC)');
}
