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
import { runIncrementalSync, WIKI_INGEST_LOCK_HELD_MESSAGE } from '../services/wikiIngestionService';
import { makeJobTracker } from './jobTracker';

export function startWikiSyncSchedule(): void {
  const hours = env.WIKI_SYNC_INTERVAL_HOURS;
  if (!hours || hours <= 0) {
    logger.info('[wikiSyncSchedule] disabled (WIKI_SYNC_INTERVAL_HOURS not set or 0)');
    return;
  }

  const intervalMs = hours * 60 * 60 * 1000;
  logger.info({ hours, intervalMs }, '[wikiSyncSchedule] incremental sync scheduled');

  const tracker = makeJobTracker('[wikiSyncSchedule]');
  let running = false;
  setInterval(() => {
    // Overlap guard: skip if the previous tick is still in flight.
    if (running) {
      logger.warn('[wikiSyncSchedule] previous tick still running — skipping this tick');
      return;
    }
    running = true;
    // Tracker swallows the rejection (counting it for escalation) so this
    // promise always resolves; .finally clears the running flag.
    void tracker(async () => {
      logger.info('[wikiSyncSchedule] incremental sync tick starting');
      try {
        const result = await runIncrementalSync();
        logger.info(result, '[wikiSyncSchedule] incremental sync tick complete');
      } catch (err) {
        if (err instanceof Error && err.message === WIKI_INGEST_LOCK_HELD_MESSAGE) {
          // Concurrent full sync holds the lock — expected, non-fatal skip.
          logger.info('[wikiSyncSchedule] incremental sync tick skipped (lock held by concurrent run)');
          return;
        }
        throw err; // real failure — let the tracker count + escalate it
      }
    }).finally(() => {
      running = false;
    });
  }, intervalMs);
}
