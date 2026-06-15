import { Router, Request, Response, NextFunction } from 'express';
import { requireDiscordRole } from '../middleware/auth';
import env from '../config/environment';
import { getTelemetryAdminView, setTelemetry } from '../services/telemetryService';
import logger from '../config/logger';

const router = Router();

// Require owner or admin Discord role (same tier as admin-users management).
router.use(requireDiscordRole(env.ADMIN_ROLE_ID));

/**
 * GET /api/admin/telemetry
 *
 * Returns global setting + all users with explicit per-user overrides.
 * Also includes "last trace uploaded at" for users with traces in the last 7 days.
 */
router.get('/', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const view = await getTelemetryAdminView();
    res.json({ data: view });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/telemetry
 *
 * Body: { scope: "global" | "user", userId?: string, enabled: boolean }
 *
 * Upserts the row, invalidates Redis cache, and broadcasts `telemetry:set`
 * over WS to affected sockets.
 */
router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { scope: scopeStr, userId, enabled } = req.body as {
      scope: string;
      userId?: string;
      enabled: boolean;
    };

    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: '`enabled` must be a boolean' });
      return;
    }

    if (scopeStr !== 'global' && scopeStr !== 'user') {
      res.status(400).json({ error: '`scope` must be "global" or "user"' });
      return;
    }

    if (scopeStr === 'user' && !userId) {
      res.status(400).json({ error: '`userId` is required when scope is "user"' });
      return;
    }

    // updatedBy: derive from admin key header for audit trail (opaque but traceable).
    const updatedBy = req.headers['x-admin-discord-id'] as string | undefined ?? 'admin-api';

    const scope = scopeStr === 'global'
      ? { kind: 'global' as const }
      : { kind: 'user' as const, userId: userId! };

    const result = await setTelemetry(scope, enabled, updatedBy);

    // Broadcast telemetry:set to affected WS clients.
    const broadcastFn = (global as any).broadcastTelemetrySet as
      ((enabled: boolean, userId: string | null) => void) | undefined;

    if (broadcastFn) {
      broadcastFn(enabled, scope.kind === 'user' ? scope.userId : null);
    } else {
      logger.warn('[adminTelemetry] broadcastTelemetrySet not registered yet');
    }

    logger.info({ scope: result.scope, enabled, updatedBy }, '[adminTelemetry] telemetry setting updated');
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

export default router;
module.exports = router;
