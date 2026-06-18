/**
 * wikiIngest cron job — weekly background ingestion of the FO76 wiki catalog.
 *
 * Schedule: every Sunday at 03:00 UTC (low-traffic window).
 * The job itself is guarded by the Redis distributed lock in wikiIngestionService,
 * so concurrent runs (e.g. cron + admin trigger) are safe.
 */

import cron from 'node-cron';
import logger from '../config/logger';
import { runWikiIngestion, WIKI_INGEST_LOCK_HELD_MESSAGE } from '../services/wikiIngestionService';
import { makeJobTracker } from './jobTracker';

export function startWikiIngestJob(): void {
  const tracker = makeJobTracker('[wikiIngest]');
  // Weekly — Sunday 03:00 UTC. Return the tracker promise so node-cron overlap
  // detection works AND consecutive REAL failures escalate warn → error. A
  // lock-held skip (a concurrent admin trigger) is expected and NOT counted as
  // a failure — we swallow it inside the tracked fn so the counter stays 0.
  cron.schedule('0 3 * * 0', () =>
    tracker(async () => {
      logger.info('[wikiIngest] scheduled weekly run starting');
      try {
        const result = await runWikiIngestion();
        logger.info(result, '[wikiIngest] scheduled run complete');
      } catch (err) {
        if (err instanceof Error && err.message === WIKI_INGEST_LOCK_HELD_MESSAGE) {
          // Concurrent run holds the lock — expected, non-fatal, not a failure.
          logger.info('[wikiIngest] scheduled run skipped (lock held by concurrent run)');
          return;
        }
        throw err; // real failure — let the tracker count + escalate it
      }
    }),
  );

  logger.info('[wikiIngest] weekly ingestion job scheduled (Sundays 03:00 UTC)');
}
