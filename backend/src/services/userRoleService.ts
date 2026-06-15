/**
 * Resolves a user's effective Discord role for the moderation pipeline.
 *
 * The dashboard auth middleware already consults `roleVerificationService`
 * (Redis cache keyed by discord_id, with the AdminUser table as source of
 * truth). This service exposes the same lookup by INTERNAL user id, so the
 * WS handlers + REST mod endpoints can ask "what's the role of the user we're
 * about to kick/ban/mute?" without going through HTTP auth machinery.
 *
 * Used by Phase 1 (WS guards) and Phase 2 (requireTargetIsNotProtected
 * middleware on /api/moderation/* mod actions).
 */
import prisma from '../config/prisma';
import { getCachedRole } from './roleVerificationService';
import logger from '../config/logger';

export type EffectiveRole = 'owner' | 'admin' | 'moderator' | 'supporter' | 'user';
const PROTECTED: ReadonlySet<EffectiveRole> = new Set(['moderator', 'admin', 'owner']);

/**
 * Return the user's effective role. Defaults to 'user' for anyone without a
 * linked Discord account or an admin_users row. Cache is consulted first
 * (sub-millisecond), DB as fallback.
 */
export async function getEffectiveRole(userId: string): Promise<EffectiveRole> {
  try {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { discordId: true } });
    if (!u?.discordId) return 'user';

    const cached = await getCachedRole(u.discordId);
    if (cached) return normalizeRole(cached);

    const admin = await prisma.adminUser.findUnique({
      where: { discordId: u.discordId },
      select: { role: true },
    });
    return admin?.role ? normalizeRole(admin.role) : 'user';
  } catch (err) {
    logger.warn({ err, userId }, 'getEffectiveRole failed — defaulting to "user"');
    return 'user';
  }
}

/** True if the target holds a protected role (moderator/admin/owner). */
export async function isProtectedTarget(userId: string): Promise<boolean> {
  const role = await getEffectiveRole(userId);
  return PROTECTED.has(role);
}

/**
 * Pure synchronous helper — returns true when `role` is a privileged moderation
 * role (owner | admin | moderator). Used by the party-chat mod-observer fan-out
 * so the same predicate is applied consistently in handlers.ts, controller, and
 * unit tests.
 */
export function isPrivilegedRole(role: EffectiveRole | string): boolean {
  return role === 'owner' || role === 'admin' || role === 'moderator';
}

function normalizeRole(s: string): EffectiveRole {
  const v = s.trim().toLowerCase();
  if (v === 'owner' || v === 'admin' || v === 'moderator' || v === 'supporter' || v === 'user') return v;
  return 'user';
}

export default { getEffectiveRole, isProtectedTarget, isPrivilegedRole };
module.exports = { getEffectiveRole, isProtectedTarget, isPrivilegedRole };
