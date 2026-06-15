/**
 * wikiIngest cron job — weekly background ingestion of the FO76 wiki catalog.
 *
 * Schedule: every Sunday at 03:00 UTC (low-traffic window).
 * The job itself is guarded by the Redis distributed lock in wikiIngestionService,
 * so concurrent runs (e.g. cron + admin trigger) are safe.
 */

import cron from 'node-cron';
import logger from '../config/logger';
import { runWikiIngestion } from '../services/wikiIngestionService';

export function startWikiIngestJob(): void {
  // Weekly — Sunday 03:00 UTC
  cron.schedule('0 3 * * 0', async () => {
    logger.info('[wikiIngest] scheduled weekly run starting');
    try {
      const result = await runWikiIngestion();
      logger.info(result, '[wikiIngest] scheduled run complete');
    } catch (err) {
      // Includes "lock already held" from a concurrent admin trigger — expected, non-fatal
      logger.warn({ err }, '[wikiIngest] scheduled run failed or was skipped');
    }
  });

  logger.info('[wikiIngest] weekly ingestion job scheduled (Sundays 03:00 UTC)');
}
