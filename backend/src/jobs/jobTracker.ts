/**
 * Failure-tracking wrapper for recurring background jobs.
 *
 * Wraps a job callback so that consecutive failures are counted. After
 * FAILURE_THRESHOLD consecutive failures the severity escalates from
 * logger.warn to logger.error, making the condition visible to any
 * alerting that watches for error-level log entries (e.g. Uptime Kuma
 * log monitors). The counter resets to zero on any successful run.
 *
 * Usage:
 *   const tracked = makeJobTracker('[my-job]', 5);
 *   cron.schedule('* * * * *', async () => {
 *     await tracked(async () => { ... });
 *   });
 */

import logger from '../config/logger';

export const FAILURE_THRESHOLD = 5;

export function makeJobTracker(label: string, threshold = FAILURE_THRESHOLD) {
  let consecutiveFailures = 0;

  return async function run(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      if (consecutiveFailures > 0) {
        logger.info({ consecutiveFailures }, `${label} recovered after ${consecutiveFailures} consecutive failure(s)`);
      }
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      if (consecutiveFailures >= threshold) {
        logger.error(
          { err, consecutiveFailures },
          `${label} failed ${consecutiveFailures} consecutive time(s) — job may be stuck`,
        );
      } else {
        logger.warn({ err, consecutiveFailures }, `${label} failed (non-fatal)`);
      }
    }
  };
}
