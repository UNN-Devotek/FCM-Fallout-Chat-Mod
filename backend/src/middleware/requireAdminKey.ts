import { Request, Response, NextFunction } from 'express';
import env from '../config/environment';
import logger from '../config/logger';
import { constantTimeEquals } from '../utils/constantTimeEquals';

/**
 * Express middleware that enforces the `X-Admin-API-Key` header matches
 * `env.ADMIN_API_KEY`. On success, emits a structured audit log entry so
 * admin-scope endpoint access is always traceable. On failure, responds
 * 401 `{ error: 'Unauthorized' }`.
 *
 * Consolidates inline admin-key checks previously sprinkled across server.ts routes.
 */
function requireAdminKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers['x-admin-api-key'];
  const provided = typeof key === 'string' ? key : undefined;

  if (!env.ADMIN_API_KEY || provided === undefined || !constantTimeEquals(provided, env.ADMIN_API_KEY)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  logger.info(
    {
      audit: 'admin-api-key',
      method: req.method,
      path: req.originalUrl || req.path,
      sourceIp: req.ip,
      userAgent: req.headers['user-agent'],
      timestamp: new Date().toISOString(),
    },
    'Admin API key authenticated request',
  );

  next();
}

export { requireAdminKey };
module.exports = { requireAdminKey };
