import env from '../config/environment';
import { shouldSkipRoleVerification } from '../utils/roleVerificationSkip';
import prisma from '../config/prisma';
import { getRedisClient } from '../config/redis';
import logger from '../config/logger';

const VERIFICATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const REDIS_ROLE_TTL = 300; // 5 minutes in seconds
let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Derive the admin role label from the Discord role IDs the user holds.
 * Returns the highest-privilege match: owner > admin > moderator.
 */
function resolveRole(discordRoles: string[]): string | null {
  if (env.OWNER_ROLE_ID && discordRoles.includes(env.OWNER_ROLE_ID)) return 'owner';
  if (env.ADMIN_ROLE_ID && discordRoles.includes(env.ADMIN_ROLE_ID)) return 'admin';
  if (env.MODERATOR_ROLE_ID && discordRoles.includes(env.MODERATOR_ROLE_ID)) return 'moderator';
  return null;
}

/**
 * Check Redis cache for a verified role.
 * Returns the cached role string, or null if not cached.
 */
async function getCachedRole(discordId: string): Promise<string | null> {
  try {
    const redis = await getRedisClient();
    return await redis.get(`role:verified:${discordId}`);
  } catch {
    return null;
  }
}

/**
 * Cache a verified role in Redis with 5-minute TTL.
 */
async function cacheRole(discordId: string, role: string): Promise<void> {
  try {
    const redis = await getRedisClient();
    await redis.set(`role:verified:${discordId}`, role, { EX: REDIS_ROLE_TTL });
  } catch (err) {
    logger.warn({ err, discordId }, 'Failed to cache verified role (non-fatal)');
  }
}

/**
 * Destroy all Express sessions for a given Discord user ID.
 * Express-session stores are keyed by session ID in Redis with prefix "sess:".
 * We scan for sessions containing the discord user ID and delete them.
 */
async function destroyAdminSessions(discordId: string): Promise<void> {
  try {
    const redis = await getRedisClient();
    // Scan for session keys -- connect-redis uses prefix "sess:"
    // node-redis v5+ uses STRING cursors for SCAN (both the argument and the
    // returned `cursor`). Start at '0' and terminate on '0' — a numeric cursor
    // would both mistype redis.scan() and make `cursor !== 0` loop forever.
    let cursor = '0';
    const toDelete: string[] = [];
    do {
      const result = await redis.scan(cursor, { MATCH: 'sess:*', COUNT: 100 });
      cursor = result.cursor;
      for (const key of result.keys) {
        try {
          const data = await redis.get(key);
          if (data) {
            const parsed = JSON.parse(data);
            if (parsed.discordUser && parsed.discordUser.id === discordId) {
              toDelete.push(key);
            }
          }
        } catch { /* skip unparseable sessions */ }
      }
    } while (cursor !== '0');

    if (toDelete.length > 0) {
      await redis.del(toDelete);
      logger.info({ discordId, sessionsDestroyed: toDelete.length }, 'Destroyed admin sessions after role revocation');
    }
  } catch (err) {
    logger.warn({ err, discordId }, 'Failed to destroy admin sessions (non-fatal)');
  }
}

/**
 * Clear the Redis role cache for a given Discord user ID.
 */
async function clearCachedRole(discordId: string): Promise<void> {
  try {
    const redis = await getRedisClient();
    await redis.del(`role:verified:${discordId}`);
  } catch { /* non-fatal */ }
}

/**
 * Verify a single admin user still has a qualifying Discord role.
 * Uses the Discord bot token (not user OAuth token) to check guild membership.
 * Returns true if the user is still valid, false if revoked.
 */
async function verifyAdminUser(adminUser: { discord_id: string; role: string; username: string }): Promise<boolean> {
  try {
    const memberRes = await fetch(
      `https://discord.com/api/v10/guilds/${env.DISCORD_SERVER_ID}/members/${adminUser.discord_id}`,
      { headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` } }
    );

    if (!memberRes.ok) {
      // User left the guild or bot can't see them -- revoke
      logger.info({ discordId: adminUser.discord_id, status: memberRes.status }, 'Admin user no longer in guild -- revoking');
      return false;
    }

    const member = await memberRes.json() as { roles?: string[] };
    const userRoles = member.roles || [];
    const role = resolveRole(userRoles);

    if (!role) {
      // No qualifying role -- revoke
      logger.info({ discordId: adminUser.discord_id }, 'Admin user lost qualifying Discord role -- revoking');
      return false;
    }

    // Update role if it changed (e.g. promoted from moderator to admin)
    if (role !== adminUser.role) {
      await prisma.adminUser.update({
        where: { discordId: adminUser.discord_id },
        data: { role },
      });
      logger.info({ discordId: adminUser.discord_id, oldRole: adminUser.role, newRole: role }, 'Admin user role updated');
    }

    // Cache the verified role
    await cacheRole(adminUser.discord_id, role);
    return true;
  } catch (err) {
    // Network error -- don't revoke on transient failures, just skip
    logger.warn({ err, discordId: adminUser.discord_id }, 'Role verification fetch failed -- skipping (will retry next cycle)');
    return true;
  }
}

/**
 * Run a full verification cycle for all admin users.
 * Rate-limited: 1 request per admin user, spaced by 1 second to respect Discord limits.
 */
async function runVerificationCycle(): Promise<void> {
  if (!env.DISCORD_TOKEN || !env.DISCORD_SERVER_ID) {
    return; // Can't verify without bot token and server ID
  }

  try {
    const adminUsers = await prisma.adminUser.findMany({
      select: { id: true, discordId: true, username: true, role: true },
    });

    if (adminUsers.length === 0) return;

    const devLoginEnabled = env.NODE_ENV === 'development' && !!env.ENABLE_DEV_LOGIN;
    logger.debug({ count: adminUsers.length }, 'Starting role verification cycle');

    for (let i = 0; i < adminUsers.length; i++) {
      const au = adminUsers[i];
      if (shouldSkipRoleVerification(au.discordId, { devLoginEnabled })) {
        continue; // synthetic dev-login persona — never guild-verifiable
      }
      const isValid = await verifyAdminUser({ discord_id: au.discordId, role: au.role, username: au.username });

      if (!isValid) {
        // Revoke: delete from admin_users, destroy sessions, clear cache
        await prisma.adminUser.delete({ where: { discordId: au.discordId } });
        await destroyAdminSessions(au.discordId);
        await clearCachedRole(au.discordId);

        // Audit log (actor is system)
        await prisma.auditLog.create({
          data: {
            action: 'admin_role_revoked',
            targetType: 'admin_user',
            reason: 'Discord role verification failed',
            metadata: { discordId: au.discordId, username: au.username, previousRole: au.role },
          },
        }).catch(() => { /* non-fatal */ });
      }

      // Rate limit: wait 1 second between Discord API calls (except after the last one)
      if (i < adminUsers.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Role verification cycle failed (non-fatal)');
  }
}

/**
 * Start the background role verification interval.
 * Safe to call multiple times -- subsequent calls are no-ops.
 */
function start(): void {
  if (intervalHandle) return;

  if (!env.DISCORD_TOKEN || !env.DISCORD_SERVER_ID) {
    logger.warn('Role verification disabled -- DISCORD_TOKEN or DISCORD_SERVER_ID not set');
    return;
  }

  // Run first cycle after a short delay (30s) to let startup complete
  setTimeout(() => {
    runVerificationCycle().catch((err) =>
      logger.warn({ err }, 'Initial role verification cycle failed (non-fatal)')
    );
  }, 30_000);

  intervalHandle = setInterval(() => {
    runVerificationCycle().catch((err) =>
      logger.warn({ err }, 'Role verification cycle failed (non-fatal)')
    );
  }, VERIFICATION_INTERVAL_MS);

  logger.info({ intervalMs: VERIFICATION_INTERVAL_MS }, 'Background role verification started');
}

/**
 * Stop the background role verification interval.
 */
function stop(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

export { start, stop, resolveRole, getCachedRole, cacheRole, runVerificationCycle, destroyAdminSessions };
module.exports = { start, stop, resolveRole, getCachedRole, cacheRole, runVerificationCycle, destroyAdminSessions };
