/**
 * Client Performance Metrics — ingest + admin query routes.
 *
 * POST /api/client-metrics          — desktop client ingest (install-token auth)
 * GET  /api/admin/client-metrics    — admin view (Discord role)
 * GET  /admin/debug/client-metrics  — admin-key mirror (CLI tooling)
 */

import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { requireClientAuth } from '../middleware/requireClientAuth';
import { requireDiscordRole } from '../middleware/auth';
import { requireAdminKey } from '../middleware/requireAdminKey';
import { z } from 'zod';
import env from '../config/environment';
import logger from '../config/logger';

// Schema defined inline (shared/src imports are outside rootDir per tsconfig).
const ClientMetricsIngestSchema = z.object({
  source:        z.enum(['overlay', 'monitor']),
  appVersion:    z.string().max(32),
  workingSetMb:  z.number().int().min(0).max(65535),
  gcHeapMb:      z.number().int().min(0).max(65535),
  cpuPercent:    z.number().min(0).max(100),
  gifCacheMb:    z.number().int().min(0).max(65535).nullable().optional(),
  fps:           z.number().min(0).max(1000).nullable().optional(),
});

import {
  recordClientMetric,
  getClientMetricsAdminView,
  MetricsWindow,
  MetricsSource,
} from '../services/clientMetricsService';
import { getRedisClient } from '../config/redis';

// ── Per-install-token rate limiter: 1 req per 5 minutes ──────────────────────

function makeRedisStore(prefix: string) {
  return new RedisStore({
    prefix,
    sendCommand: async (...args: string[]) => {
      try {
        const client = await getRedisClient();
        return client.sendCommand(args);
      } catch (err) {
        logger.warn({ err, prefix }, 'Rate limit Redis store unavailable, failing open');
        throw err;
      }
    },
  });
}

const clientMetricsIngestLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.user?.installToken || req.headers['x-auth-token'] || req.ip,
  store: makeRedisStore('rl_cmetrics:'),
  message: {
    type: 'https://fo76chat.app/errors/429',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Client metrics: submit at most once per 5 minutes.',
  },
});

// ── Ingest route ──────────────────────────────────────────────────────────────

const ingestRouter = Router();

ingestRouter.post(
  '/',
  requireClientAuth,
  clientMetricsIngestLimiter,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = ClientMetricsIngestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          type: 'https://fo76chat.app/errors/400',
          title: 'Bad Request',
          status: 400,
          detail: parsed.error.issues.map(i => i.message).join('; '),
        });
        return;
      }

      const installToken = req.user!.installToken;
      await recordClientMetric(installToken, parsed.data);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

// ── Admin query route ─────────────────────────────────────────────────────────

const adminRouter = Router();
adminRouter.use(requireDiscordRole(env.ADMIN_ROLE_ID));

adminRouter.get(
  '/',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const raw = (req.query as any);
      const window: MetricsWindow = ['1h', '24h', '7d', '30d'].includes(raw.window)
        ? (raw.window as MetricsWindow) : '24h';
      const source: MetricsSource = ['overlay', 'monitor'].includes(raw.source)
        ? (raw.source as MetricsSource) : 'all';
      const view = await getClientMetricsAdminView(window, source);
      res.json({ data: view });
    } catch (err) {
      next(err);
    }
  },
);

// ── Admin-key debug mirror ────────────────────────────────────────────────────

const debugRouter = Router();
debugRouter.use(requireAdminKey);

debugRouter.get(
  '/',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const raw = (req.query as any);
      const window: MetricsWindow = ['1h', '24h', '7d', '30d'].includes(raw.window)
        ? (raw.window as MetricsWindow) : '24h';
      const source: MetricsSource = ['overlay', 'monitor'].includes(raw.source)
        ? (raw.source as MetricsSource) : 'all';
      const view = await getClientMetricsAdminView(window, source);
      res.json({ data: view });
    } catch (err) {
      next(err);
    }
  },
);

export { ingestRouter, adminRouter, debugRouter };
