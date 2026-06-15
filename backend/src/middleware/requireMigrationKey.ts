import { Request, Response, NextFunction } from 'express';
import logger from '../config/logger';
import { constantTimeEquals } from '../utils/constantTimeEquals';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  SECURITY NOTICE — MIGRATION KEY GATE                                   ║
 * ║                                                                          ║
 * ║  This middleware guards raw database access (ad-hoc SQL, pg_dump,        ║
 * ║  pg_restore).  The key holder can read or destroy ALL data.             ║
 * ║                                                                          ║
 * ║  • MIGRATION_API_KEY must be a long random secret (≥32 chars).          ║
 * ║  • It must be DIFFERENT from ADMIN_API_KEY and ADMIN_RELEASE_TOKEN.     ║
 * ║  • Rotate it immediately after any dump/restore operation.               ║
 * ║  • If MIGRATION_API_KEY is not set, this middleware always returns 401   ║
 * ║    (fail-closed — never allows access when unconfigured).               ║
 * ║  • The full key value is NEVER written to logs.                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Checks the `X-Migration-Key` request header against process.env.MIGRATION_API_KEY
 * using a constant-time comparison to prevent timing attacks.
 */
function requireMigrationKey(req: Request, res: Response, next: NextFunction): void {
  const configured = process.env.MIGRATION_API_KEY;

  // Fail-closed: if the key is not configured, always deny.
  if (!configured) {
    logger.warn(
      {
        path: req.originalUrl || req.path,
        method: req.method,
        sourceIp: req.ip,
      },
      'Migration endpoint access denied: MIGRATION_API_KEY is not configured',
    );
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const provided = req.headers['x-migration-key'];
  const providedStr = typeof provided === 'string' ? provided : undefined;

  if (providedStr === undefined || !constantTimeEquals(providedStr, configured)) {
    logger.warn(
      {
        path: req.originalUrl || req.path,
        method: req.method,
        sourceIp: req.ip,
        keyProvided: providedStr !== undefined,
      },
      'Migration endpoint access denied: invalid or missing X-Migration-Key',
    );
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  logger.info(
    {
      audit: 'migration-key',
      method: req.method,
      path: req.originalUrl || req.path,
      sourceIp: req.ip,
      userAgent: req.headers['user-agent'],
      timestamp: new Date().toISOString(),
    },
    'Migration API key authenticated request',
  );

  next();
}

export { requireMigrationKey };
module.exports = { requireMigrationKey };
