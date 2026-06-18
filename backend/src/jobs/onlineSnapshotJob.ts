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

/**
 * Subset of `node-cron` we depend on. A scheduler takes a cron expression and
 * a task; the task may be async. Injectable so the overlap guard can be tested
 * without real timers.
 */
export type CronScheduler = (
  expression: string,
  task: () => void | Promise<void>,
) => unknown;

export interface OnlineSnapshotDeps {
  /** Schedules a cron task. Defaults to `node-cron`'s `cron.schedule`. */
  schedule?: CronScheduler;
  /** Returns the current open WebSocket client count. */
  getClientCount?: () => number;
  /** Executes a parameterized SQL query. */
  dbQuery?: (text: string, params?: any[]) => Promise<{ rowCount?: number | null }>;
}

export function startOnlineSnapshotJob(deps: OnlineSnapshotDeps = {}): void {
  const schedule: CronScheduler = deps.schedule ?? ((expr, task) => cron.schedule(expr, task));
  const clientCount = deps.getClientCount ?? getClientCount;
  const runQuery = deps.dbQuery ?? dbQuery;

  const snapshotTracker = makeJobTracker('[onlineSnapshot]');
  const purgeTracker = makeJobTracker('[onlineSnapshot:purge]');

  // Every 5 minutes — sample the current WS client count.
  // Overlap guard: node-cron does not await async callbacks, so a slow DB
  // write can still be in flight when the next tick fires. Skip (logged warn)
  // rather than queue duplicate inserts. Inside the guard the insert runs
  // through the tracker so a genuine DB failure re-throws and consecutive
  // failures escalate warn → error; we return the tracker promise so node-cron's
  // own overlap detection also sees the tick as in-flight, and the `.finally`
  // reliably clears the running flag (the tracker swallows the rejection).
  let snapshotRunning = false;
  schedule('*/5 * * * *', () => {
    if (snapshotRunning) {
      logger.warn('[onlineSnapshot] previous insert still running — skipping this tick');
      return;
    }
    snapshotRunning = true;
    const onlineCount = clientCount();
    return snapshotTracker(async () => {
      await runQuery(
        'INSERT INTO online_snapshots (online_count) VALUES ($1)',
        [onlineCount],
      );
    }).finally(() => {
      snapshotRunning = false;
    });
  });

  // Daily at 04:07 UTC — purge snapshots older than 7 days. Same overlap guard
  // + tracker pattern as the sampler.
  let purgeRunning = false;
  schedule('7 4 * * *', () => {
    if (purgeRunning) {
      logger.warn('[onlineSnapshot] previous purge still running — skipping this tick');
      return;
    }
    purgeRunning = true;
    return purgeTracker(async () => {
      const result = await runQuery(
        "DELETE FROM online_snapshots WHERE captured_at < now() - interval '7 days'",
        [],
      );
      logger.info({ count: result.rowCount }, '[onlineSnapshot] retention purge complete');
    }).finally(() => {
      purgeRunning = false;
    });
  });

  logger.info('[onlineSnapshot] snapshot job scheduled (*/5 * * * *); purge job at 04:07 UTC');
}
