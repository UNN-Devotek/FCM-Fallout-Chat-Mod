import { Router, Request, Response, NextFunction } from 'express';
import { requireDiscordRole } from '../middleware/auth';
import { requireAdminKey } from '../middleware/requireAdminKey';
import env from '../config/environment';
import { getCommunityStats, StatsRange } from '../services/communityStatsService';

const VALID_RANGES: StatsRange[] = ['all', '90d', '60d', '30d', '7d', '1d'];

function parseRange(raw: unknown): StatsRange {
  if (typeof raw === 'string' && VALID_RANGES.includes(raw as StatsRange)) {
    return raw as StatsRange;
  }
  return '90d';
}

async function handleCommunityStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const range = parseRange(req.query.range);
    const stats = await getCommunityStats(range);
    res.json({ data: stats });
  } catch (err) {
    next(err);
  }
}

// Discord-OAuth gated route: GET /api/admin/community-stats
const adminRouter = Router();
adminRouter.use(requireDiscordRole(env.ADMIN_ROLE_ID));
adminRouter.get('/', handleCommunityStats);

// API-key gated debug mirror: GET /admin/debug/community-stats
const debugRouter = Router();
debugRouter.use(requireAdminKey);
debugRouter.get('/', handleCommunityStats);

export { adminRouter, debugRouter };
module.exports = { adminRouter, debugRouter };
