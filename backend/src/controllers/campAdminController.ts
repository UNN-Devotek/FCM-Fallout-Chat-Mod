/**
 * campAdminController — admin endpoints for the CAMP database.
 *
 * POST /api/admin/camp/ingest
 *   Requires Discord role owner|admin.
 *   Runs runCampSync() (full re-ingest + image mirror + Redis hash store).
 *   Responds with { data: { status, fetched, upserted, imagesAdded } }.
 *
 * GET /api/admin/camp/updates
 *   Returns update-availability status (cached ~5 min in Redis).
 *   Response: { data: CampUpdateStatus }
 */

import { Request, Response, NextFunction } from 'express';
import { runCampSync, getCampUpdateStatus } from '../services/campService';
import logger from '../config/logger';

/** POST /api/admin/camp/ingest — full re-sync (blocks until complete). */
export async function triggerCampIngest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    logger.info('[campAdmin] admin-triggered CAMP sync started');
    const result = await runCampSync();
    logger.info({ ...result }, '[campAdmin] admin-triggered CAMP sync completed');
    res.json({ data: { status: 'completed', ...result } });
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/camp/updates — update-availability check (cached ~5 min). */
export async function getCampUpdates(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const status = await getCampUpdateStatus();
    res.json({ data: status });
  } catch (err) {
    next(err);
  }
}
