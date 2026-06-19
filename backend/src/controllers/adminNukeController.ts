import { Request, Response, NextFunction } from 'express';
import prisma from '../config/prisma';
import logger from '../config/logger';
import { getRedisClient } from '../config/redis';

/**
 * POST /admin/nuke-users — destructive one-shot wipe of every per-user DB row
 * plus all Redis `session:*` keys. Used once during the X-App-Client-Key hard
 * flip so nothing lingering references the old auth state.
 *
 * Auth: `requireAdminKey` (timing-safe + audit-logged).
 *
 * Safety: must include `?confirm=yes-delete-everything` query param OR
 * `{ confirm: 'yes-delete-everything' }` in the JSON body. Without the
 * incantation the endpoint returns 400.
 *
 * Delete order (User has some Restrict FKs — cannot rely on cascade alone):
 *   1. messages        (FK User onDelete: Restrict)
 *   2. audit_logs      (FK User onDelete: SetNull — wiped explicitly)
 *   3. server_messages (FK User onDelete: Cascade — wiped explicitly for clarity)
 *   4. player_reports  (FK User onDelete: Cascade)
 *   5. reports         (FK User onDelete: Cascade on both reporter/target)
 *   6. staff_applications (no FK, but user asked to wipe)
 *   7. users           (cascades remaining sessions)
 *
 * Then SCAN+UNLINK every `session:*` key in Redis.
 */
async function nukeUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const queryConfirm = typeof req.query.confirm === 'string' ? req.query.confirm : undefined;
    const body = (req.body ?? {}) as { confirm?: unknown };
    const bodyConfirm = typeof body.confirm === 'string' ? body.confirm : undefined;
    const confirm = queryConfirm ?? bodyConfirm;

    if (confirm !== 'yes-delete-everything') {
      res.status(400).json({
        error: 'Confirmation required',
        detail: "Include ?confirm=yes-delete-everything in the query string or { confirm: 'yes-delete-everything' } in the JSON body.",
      });
      return;
    }

    logger.warn({ audit: 'admin-nuke-users', sourceIp: req.ip }, 'Admin nuke-users initiated');

    // 1. DB transaction — delete children then users.
    const deletedUsers = await prisma.$transaction(async (tx) => {
      await tx.message.deleteMany({});
      await tx.auditLog.deleteMany({});
      await tx.playerReport.deleteMany({});
      await tx.report.deleteMany({});
      await tx.staffApplication.deleteMany({});
      const { count } = await tx.user.deleteMany({});
      return count;
    });

    // 2. Clear Redis session keys via SCAN + UNLINK (safer than KEYS).
    const redis = await getRedisClient();
    let clearedSessions = 0;
    // node-redis v5+ uses STRING cursors for SCAN (argument and return). Start at
    // '0' and terminate on '0'; a numeric cursor mistypes redis.scan() under v6.
    let cursor = '0';
    do {
      const reply = await redis.scan(cursor, { MATCH: 'session:*', COUNT: 500 });
      const keys: string[] = reply.keys;
      if (keys.length > 0) {
        await redis.unlink(keys);
        clearedSessions += keys.length;
      }
      cursor = reply.cursor;
    } while (cursor !== '0');

    logger.warn(
      { audit: 'admin-nuke-users-complete', deletedUsers, clearedSessions },
      'Admin nuke-users completed',
    );

    res.json({ data: { deletedUsers, clearedSessions } });
  } catch (err) {
    logger.error({ err }, 'Admin nuke-users failed');
    next(err);
  }
}

export { nukeUsers };
module.exports = { nukeUsers };
