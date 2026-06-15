/**
 * GET /api/public/stats — world-readable aggregate statistics.
 * No authentication required. Results cached 30s in publicStatsService.
 */

import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { getRedisClient } from '../config/redis';
import { clientIp } from '../utils/clientIp';
import { getPublicStats } from '../services/publicStatsService';

const router = Router();

// 60 req / 15 min per IP — consistent with other public endpoints.
const publicStatsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => clientIp(req),
  store: new RedisStore({
    prefix: 'rl_pubstats:',
    sendCommand: async (...args: string[]) => {
      try {
        const client = await getRedisClient();
        return client.sendCommand(args);
      } catch (err) {
        // Fail open so a Redis outage doesn't break the public endpoint.
        throw err;
      }
    },
  }),
  message: {
    type: 'https://fo76chat.app/errors/429',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Public stats rate limit exceeded. Please wait before retrying.',
  },
});

router.get('/', publicStatsLimiter, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const stats = await getPublicStats();
    res.json({ data: stats });
  } catch (err) {
    next(err);
  }
});

export default router;
module.exports = router;
