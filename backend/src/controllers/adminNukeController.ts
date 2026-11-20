import { bindRequiredTransactionClient, isPrismaAtomicRefusal, isRowCountNoChange, runRequiredBundle, runRequiredMutation, runRequiredTransaction } from '../lib/requiredEffects';
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
  return runRequiredBundle('identity', 'adminNukeController:70c2f231d802', async () => {
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
    const deletedUsers = await runRequiredTransaction('identity', 'b5b129a90401503c72492cf2', { stage: 'transaction-completion-unconfirmed' }, () => prisma.$transaction(async (tx) => {
      bindRequiredTransactionClient(tx);
      await runRequiredMutation('identity', '37bda99ec72ce09c0b735c2f', { stage: 'primary-write-unconfirmed' }, () => tx.message.deleteMany({}), isPrismaAtomicRefusal, tx, isRowCountNoChange);
      await runRequiredMutation('identity', '254b65de5c9148fafc2a6658', { stage: 'primary-write-unconfirmed' }, () => tx.auditLog.deleteMany({}), isPrismaAtomicRefusal, tx, isRowCountNoChange);
      await runRequiredMutation('identity', '555bb686a8a1b01de1935fe0', { stage: 'primary-write-unconfirmed' }, () => tx.playerReport.deleteMany({}), isPrismaAtomicRefusal, tx, isRowCountNoChange);
      await runRequiredMutation('identity', 'daafb05633f68e1488da7e28', { stage: 'primary-write-unconfirmed' }, () => tx.report.deleteMany({}), isPrismaAtomicRefusal, tx, isRowCountNoChange);
      await runRequiredMutation('identity', '35f3a3a18510723e545b6dc8', { stage: 'primary-write-unconfirmed' }, () => tx.staffApplication.deleteMany({}), isPrismaAtomicRefusal, tx, isRowCountNoChange);
      const { count } = await runRequiredMutation('identity', 'd461354ac404ceef3d672064', { stage: 'primary-write-unconfirmed' }, () => tx.user.deleteMany({}), isPrismaAtomicRefusal, tx, isRowCountNoChange);
      return count;
    }), { confirmedRollback: isPrismaAtomicRefusal });

    // 2. Clear Redis session keys via SCAN + UNLINK (safer than KEYS).
    // Confirmation and the completed SQL phase accept coupled session cleanup.
    // A failed discovery cannot prove absent Redis authority, even with zero SQL
    // rows. Successful discovery is a read, not committed mutation progress.
    const redis = await runRequiredMutation('session', 'c094786b8c7957313166e338', {
      stage: 'session-cleanup-client-discovery-unconfirmed',
    }, () => getRedisClient(), undefined, undefined, () => true);
    let clearedSessions = 0;
    // node-redis v5+ uses STRING cursors for SCAN (argument and return). Start at
    // '0' and terminate on '0'; a numeric cursor mistypes redis.scan() under v6.
    let cursor = '0';
    do {
      const reply = await runRequiredMutation('session', 'ac0baf2a565a8e4cf5d9aaf4', {
        stage: 'session-cleanup-scan-unconfirmed', count: clearedSessions,
      }, () => redis.scan(cursor, { MATCH: 'session:*', COUNT: 500 }), undefined, undefined, () => true);
      const keys: string[] = reply.keys;
      if (keys.length > 0) {
        await runRequiredMutation('session', 'f523d75dc27aee7414c4a2ef', {
          stage: 'session-unlink-unconfirmed', targetCount: keys.length,
          count: clearedSessions,
        }, () => redis.unlink(keys), undefined, undefined, isRowCountNoChange);
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

  });
}

export { nukeUsers };
module.exports = { nukeUsers };
