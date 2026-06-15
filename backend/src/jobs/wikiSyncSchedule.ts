/**
 * wikiSyncSchedule — periodic incremental sync of the FO76 wiki catalog.
 *
 * Enabled when WIKI_SYNC_INTERVAL_HOURS > 0.  Each tick calls runIncrementalSync(),
 * which fetches only the pages changed since the last run via Fandom recentchanges.
 * The underlying runWikiIngestion() holds the Redis distributed lock, so this job
 * is safe to run alongside the weekly full sync or an admin-triggered ingest.
 *
 * Default: disabled (WIKI_SYNC_INTERVAL_HOURS=0 or unset).
 */

import logger from '../config/logger';
import env from '../config/environment';
import { runIncrementalSync } from '../services/wikiIngestionService';

export function startWikiSyncSchedule(): void {
  const hours = env.WIKI_SYNC_INTERVAL_HOURS;
  if (!hours || hours <= 0) {
    logger.info('[wikiSyncSchedule] disabled (WIKI_SYNC_INTERVAL_HOURS not set or 0)');
    return;
  }

  const intervalMs = hours * 60 * 60 * 1000;
  logger.info({ hours, intervalMs }, '[wikiSyncSchedule] incremental sync scheduled');

  setInterval(async () => {
    logger.info('[wikiSyncSchedule] incremental sync tick starting');
    try {
      const result = await runIncrementalSync();
      logger.info(result, '[wikiSyncSchedule] incremental sync tick complete');
    } catch (err) {
      // "lock already held" from a concurrent full sync is expected — non-fatal
      logger.warn({ err }, '[wikiSyncSchedule] incremental sync tick failed or was skipped');
    }
  }, intervalMs);
}
