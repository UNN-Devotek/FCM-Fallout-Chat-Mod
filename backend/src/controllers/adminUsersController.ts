import { createRequiredAudit, isPrismaAtomicRefusal, runRequiredBundle, runRequiredMutation } from '../lib/requiredEffects';
import { Request, Response, NextFunction } from 'express';
import { paramsOf } from '../utils/reqParams';
import prisma from '../config/prisma';
import { createError } from '../middleware/errorHandler';
import logger from '../config/logger';

const VALID_ROLES = ['owner', 'admin', 'moderator'];

/**
 * GET /api/admin-users -- owner only
 * List all persistent admin user records.
 */
async function listAdminUsers(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const users = await prisma.adminUser.findMany({
      select: { id: true, discordId: true, username: true, role: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ data: users });
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/admin-users/:discordId -- owner only
 * Update an admin user's role.
 */
async function updateAdminUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  return runRequiredBundle('authority', 'adminUsersController:f68d1cde0a7a', async () => {
  const { discordId } = paramsOf(req);
  const { role } = req.body;

  if (!role || !VALID_ROLES.includes(role)) {
    return next(createError(400, `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`));
  }

  // Prevent owners from demoting themselves
  if (req.adminUser && req.adminUser.id === discordId && role !== 'owner') {
    return next(createError(400, 'Cannot demote yourself'));
  }

  try {
    const updated = await runRequiredMutation('authority', '60ff132cb3b5f31b55e6e047', { stage: 'primary-write-unconfirmed', discordId: discordId }, () => prisma.adminUser.update({
      where: { discordId },
      data: { role },
      select: { id: true, discordId: true, username: true, role: true, updatedAt: true },
    }), isPrismaAtomicRefusal, undefined, undefined);

    await createRequiredAudit(prisma.auditLog, {
      data: {
        action: 'admin_role_changed',
        targetType: 'admin_user',
        reason: `Role changed to ${role}`,
        metadata: { discordId, newRole: role, changedBy: req.adminUser?.id },
      },
    }).catch((err: Error) => logger.warn({ err }, 'Audit log for role change failed (non-fatal)'));

    res.json({ data: updated });
  } catch (err: any) {
    if (err.code === 'P2025') return next(createError(404, 'Admin user not found'));
    next(err);
  }

  });
}

/**
 * DELETE /api/admin-users/:discordId -- owner only
 * Remove an admin user record.
 */
async function deleteAdminUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  return runRequiredBundle('authority', 'adminUsersController:7f47dbb48cd5', async () => {
  const { discordId } = paramsOf(req);

  // Prevent owners from deleting themselves
  if (req.adminUser && req.adminUser.id === discordId) {
    return next(createError(400, 'Cannot delete yourself'));
  }

  try {
    const deleted = await runRequiredMutation('authority', '0470219d94c766ca976b903a', { stage: 'primary-write-unconfirmed', discordId: discordId }, () => prisma.adminUser.delete({
      where: { discordId },
      select: { id: true, discordId: true, username: true, role: true },
    }), isPrismaAtomicRefusal, undefined, undefined);

    await createRequiredAudit(prisma.auditLog, {
      data: {
        action: 'admin_user_removed',
        targetType: 'admin_user',
        reason: 'Removed by owner',
        metadata: { discordId, username: deleted.username, removedBy: req.adminUser?.id },
      },
    }).catch((err: Error) => logger.warn({ err }, 'Audit log for admin removal failed (non-fatal)'));

    res.status(204).send();
  } catch (err: any) {
    if (err.code === 'P2025') return next(createError(404, 'Admin user not found'));
    next(err);
  }

  });
}

export { listAdminUsers, updateAdminUser, deleteAdminUser };
module.exports = { listAdminUsers, updateAdminUser, deleteAdminUser };
