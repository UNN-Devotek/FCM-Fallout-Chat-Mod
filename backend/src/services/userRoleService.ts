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
import env from '../config/environment';

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

export interface TargetProtection {
  /** False when no users row exists for the id. */
  found: boolean;
  /** Protected staff role held by the target, or null when not protected. */
  role: EffectiveRole | null;
}

/**
 * Cheap, in-memory check of the Discord bot's guild member cache for an
 * owner/admin/moderator role. Never calls the Discord API: a member that is
 * not in the gateway cache simply yields null (other sources still apply).
 */
function cachedDiscordStaffRole(discordId: string): EffectiveRole | null {
  try {
    // Lazy require: discordService is heavy and imports moderation code.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getDiscordClient } = require('./discordService') as { getDiscordClient?: () => any };
    const client = getDiscordClient?.();
    const guild = env?.DISCORD_SERVER_ID ? client?.guilds?.cache?.get(env.DISCORD_SERVER_ID) : null;
    const member = guild?.members?.cache?.get(discordId);
    const roles = member?.roles?.cache;
    if (!roles || typeof roles.has !== 'function') return null;
    if (env.OWNER_ROLE_ID && roles.has(env.OWNER_ROLE_ID)) return 'owner';
    if (env.ADMIN_ROLE_ID && roles.has(env.ADMIN_ROLE_ID)) return 'admin';
    if (env.MODERATOR_ROLE_ID && roles.has(env.MODERATOR_ROLE_ID)) return 'moderator';
    return null;
  } catch {
    return null;
  }
}

/**
 * Fail-closed protection lookup for moderation actions. Unlike
 * getEffectiveRole (which degrades to 'user' so privilege grants fail safe),
 * this THROWS when the users/admin_users lookup fails, so a database hiccup
 * can never silently strip staff protection. A target is protected when any
 * source says so: the verified-role Redis cache, the admin_users row, or a
 * staff Discord role in the bot's in-memory guild member cache (covers staff
 * who never signed in to the dashboard and so have no admin_users row).
 */
export async function resolveTargetProtection(userId: string): Promise<TargetProtection> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { discordId: true } });
  if (!u) return { found: false, role: null };
  if (!u.discordId) return { found: true, role: null };

  const cached = await getCachedRole(u.discordId);
  if (cached && PROTECTED.has(normalizeRole(cached))) return { found: true, role: normalizeRole(cached) };

  const admin = await prisma.adminUser.findUnique({ where: { discordId: u.discordId }, select: { role: true } });
  if (admin?.role && PROTECTED.has(normalizeRole(admin.role))) return { found: true, role: normalizeRole(admin.role) };

  return { found: true, role: cachedDiscordStaffRole(u.discordId) };
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

export default { getEffectiveRole, isProtectedTarget, isPrivilegedRole, resolveTargetProtection };
module.exports = { getEffectiveRole, isProtectedTarget, isPrivilegedRole, resolveTargetProtection };
