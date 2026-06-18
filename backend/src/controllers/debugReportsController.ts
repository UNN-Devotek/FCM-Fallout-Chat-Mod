import { Request, Response, NextFunction } from 'express';
import { getRedisClient } from '../config/redis';
import prisma from '../config/prisma';
import logger from '../config/logger';
import { createError } from '../middleware/errorHandler';

// Stores the last 5 reports per installToken (24 h TTL) to capture short-term evolution.
const REPORTS_KEY = (installToken: string) => `debug-reports:${installToken}`;
const RETAIN_COUNT = 5;
const REPORT_TTL_SEC = 24 * 60 * 60;

/**
 * POST /api/debug/overlay-report
 * Auth: X-Auth-Token, enforced by requireClientAuth middleware at route
 * registration. Legacy X-App-Client-Key fallback was removed after the
 * user-table wipe.
 * Body: any JSON — stored verbatim under Redis list keyed by installToken.
 */
async function submitOverlayReport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = req.body ?? {};
    const installToken = typeof body.installToken === 'string' ? body.installToken : '';
    if (!installToken || installToken.length > 128) {
      return next(createError(400, 'installToken required'));
    }

    const payload = JSON.stringify({
      receivedAt: new Date().toISOString(),
      remoteAddr: req.ip,
      ...body,
    });

    const redis = await getRedisClient();
    await redis.lPush(REPORTS_KEY(installToken), payload);
    await redis.lTrim(REPORTS_KEY(installToken), 0, RETAIN_COUNT - 1);
    await redis.expire(REPORTS_KEY(installToken), REPORT_TTL_SEC);

    logger.debug({ installToken: installToken.slice(0, 8) + '...' }, 'Diagnostic report stored');
    res.json({ data: { ok: true } });
  } catch (err) { next(err); }
}

/**
 * GET /admin/debug/overlay-reports?userId=<uuid>
 * GET /admin/debug/overlay-reports?installToken=<token>
 * Auth: X-Admin-API-Key.
 * Returns the last N reports for the given user or install, parsed.
 */
async function listOverlayReports(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // req.query values can be string | string[] | ParsedQs (Express delivers an
    // array for ?installToken=a&installToken=b, or an object for ?userId[x]=y).
    // Guard for a plain string before use — anything else is rejected as 400 —
    // so these never reach Redis key building or Prisma's where:{id} as a
    // non-string (type confusion / query injection).
    const rawInstallToken = req.query.installToken;
    const rawUserId       = req.query.userId;
    if (rawInstallToken !== undefined && typeof rawInstallToken !== 'string') {
      return next(createError(400, 'installToken must be a string'));
    }
    if (rawUserId !== undefined && typeof rawUserId !== 'string') {
      return next(createError(400, 'userId must be a string'));
    }
    let installToken: string | undefined = rawInstallToken;
    const userId: string | undefined     = rawUserId;

    if (!installToken && userId) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { installToken: true },
      });
      if (!user) return next(createError(404, 'User not found'));
      installToken = user.installToken;
    }

    if (!installToken) {
      return next(createError(400, 'Provide ?userId or ?installToken'));
    }

    const redis = await getRedisClient();
    const raw = await redis.lRange(REPORTS_KEY(installToken), 0, -1);
    const reports = raw.map(s => {
      try { return JSON.parse(s); } catch { return { parseError: true, raw: s }; }
    });

    res.json({
      data: {
        installToken: installToken.slice(0, 8) + '…' + installToken.slice(-4),
        count: reports.length,
        reports,
      },
    });
  } catch (err) { next(err); }
}

export { submitOverlayReport, listOverlayReports };
module.exports = { submitOverlayReport, listOverlayReports };
