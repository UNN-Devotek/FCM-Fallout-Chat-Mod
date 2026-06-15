/**
 * wikiAdminController — admin endpoints for the wiki catalog.
 *
 * POST /api/admin/wiki/ingest
 *   body: { mode?: 'incremental' | 'full', titles?: string[] }
 *   Requires Discord role owner|admin.
 *   Guarded by min-interval (1h) + Redis distributed lock.
 *   Fires ingestion asynchronously; responds immediately with { data: { status } }.
 *
 * GET /api/admin/wiki/updates
 *   Returns update-availability status (changed/new pages since last sync).
 *   Result cached ~5 min in Redis so it doesn't hammer Fandom.
 */

import { Request, Response, NextFunction } from 'express';
import { createError } from '../middleware/errorHandler';
import {
  checkIngestAllowed,
  runWikiIngestion,
  runIncrementalSync,
  getWikiUpdateStatus,
} from '../services/wikiIngestionService';
import logger from '../config/logger';

/**
 * POST /api/admin/wiki/ingest
 *
 * Fires the ingestion run in the background (non-blocking). Responds 202 with
 * { data: { status: 'started', mode } } immediately, or 409 if already running /
 * rate-limited, or 500 on unexpected errors.
 *
 * Body params:
 *   mode    – 'incremental' (default) | 'full'
 *   titles  – optional string[] override; bypasses mode and category walk
 */
export async function triggerWikiIngest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Optional targeted titles (testing / re-sync a specific set). When present,
    // the category walk is skipped, but we still apply a lighter rate guard.
    const TARGETED_MAX_TITLES  = 200;
    const TARGETED_TITLE_MAXLEN = 300; // per-title length cap (spec §7)

    const titles = Array.isArray(req.body?.titles)
      ? (req.body.titles as unknown[])
          .filter((t): t is string => typeof t === 'string' && t.trim().length > 0 && t.trim().length <= TARGETED_TITLE_MAXLEN)
          .slice(0, TARGETED_MAX_TITLES)
      : undefined;

    const mode: 'incremental' | 'full' = titles
      ? 'full'  // explicit titles override always uses the full per-title path
      : (req.body?.mode === 'full' ? 'full' : 'incremental');

    // Rate-limit check: applies to full runs AND targeted-title runs (spec §7).
    // Targeted runs bypass the category walk but can still hammer Fandom if
    // called in a tight loop — apply the same 1-hour distributed lock.
    if (mode === 'full' || titles) {
      const blocked = await checkIngestAllowed();
      if (blocked) {
        next(createError(409, blocked));
        return;
      }
    }

    // Incremental (no explicit titles) only touches pages changed/new since the
    // last sync, so it's cheap — AWAIT it and return the counts for immediate UI
    // feedback. Full runs (~80 min) and targeted title sets stay fire-and-forget.
    if (mode === 'incremental' && !titles) {
      const result = await runIncrementalSync();
      logger.info({ ...result, mode }, '[wikiAdmin] incremental ingest completed');
      res.status(200).json({ data: { mode, status: 'completed', ...result } });
      return;
    }

    const runFn = titles ? () => runWikiIngestion(titles) : () => runWikiIngestion();
    runFn().then(result => {
      logger.info({ ...result, mode }, '[wikiAdmin] admin-triggered ingest completed');
    }).catch(err => {
      logger.error({ err, mode }, '[wikiAdmin] admin-triggered ingest failed');
    });

    res.status(202).json({ data: { status: 'started', mode } });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/wiki/updates
 *
 * Returns update-availability info for the wiki catalog. Queries Fandom
 * recentchanges since the last sync (cached ~5 min). Safe to call frequently.
 *
 * Response 200: { data: WikiUpdateStatus }
 *   lastSyncAt        – ISO timestamp of last completed sync, or null
 *   updatesAvailable  – total distinct pages changed/created since last sync
 *   changedPages      – count of edits to existing pages
 *   newPages          – count of newly created pages
 *   checkedAt         – ISO timestamp of this check
 */
export async function getWikiUpdates(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const status = await getWikiUpdateStatus();
    res.json({ data: status });
  } catch (err) {
    next(err);
  }
}
